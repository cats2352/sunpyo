(() => {
  'use strict';

  const KEY = 'sunpyo-canvas-v2';
  const SIZES = {
    'goodnotes-p': [1200, 1550],
    'goodnotes-l': [1550, 1200],
    'a4-p': [1240, 1754],
    'a4-l': [1754, 1240],
    square: [1200, 1200],
  };
  const $ = (selector) => document.querySelector(selector);
  const board = $('#board');
  const ctx = board.getContext('2d');
  const page = $('#page');
  const pageFrame = $('#pageFrame');
  const stage = $('#stage');
  const settingsPanel = $('#settingsPanel');
  const status = $('#statusText');
  const saveState = $('#saveState');
  const controls = {
    color: $('#color'), style: $('#lineStyle'), width: $('#lineWidth'),
    grid: $('#gridSize'), align: $('#alignAssist'), font: $('#fontSize'),
    size: $('#pageSize'), transparent: $('#transparent'),
  };

  let state = { lines: [], strokes: [], texts: [], page: 'goodnotes-p' };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved && SIZES[saved.page]) {
      state = { ...state, ...saved, lines: saved.lines || [], strokes: saved.strokes || [], texts: saved.texts || [] };
    }
  } catch (_) { /* 손상된 임시 저장 내용은 무시합니다. */ }

  let history = [];
  let future = [];
  let tool = 'line';
  let draftLine = null;
  let draftStroke = null;
  let lineGuide = null;
  let selectedText = null;
  let dragText = null;
  let panDrag = null;
  let activePenPointerId = null;
  let pencilOnly = false;
  let pencilModeManuallyOff = false;
  const fingers = new Map();
  const ignoredFingers = new Set();
  let pinch = null;
  let editor = null;
  let editSnapshot = null;
  let editText = null;
  let editCell = null;
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const baseSize = () => SIZES[state.page] || SIZES['goodnotes-p'];
  const mobileView = () => window.matchMedia('(max-width: 760px)').matches;
  let zoomFactor = 1;
  let viewScale = 1;

  function fitScale() {
    if (!mobileView()) return 1;
    const style = getComputedStyle(stage);
    const available = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return Math.min(1, Math.max(0.15, available / board.width));
  }

  function applyViewScale(preserveCenter = true) {
    const previous = viewScale;
    const centerX = (stage.scrollLeft + stage.clientWidth / 2) / previous;
    const centerY = (stage.scrollTop + stage.clientHeight / 2) / previous;
    viewScale = fitScale() * zoomFactor;
    page.style.transform = `scale(${viewScale})`;
    pageFrame.style.width = `${board.width * viewScale}px`;
    pageFrame.style.height = `${board.height * viewScale}px`;
    $('#zoomReset').textContent = zoomFactor === 1 ? (mobileView() ? '맞춤' : '100%') : `${Math.round(zoomFactor * 100)}%`;
    $('#zoomOut').disabled = zoomFactor <= 1;
    $('#zoomIn').disabled = zoomFactor >= 4;
    if (preserveCenter) {
      stage.scrollLeft = Math.max(0, centerX * viewScale - stage.clientWidth / 2);
      stage.scrollTop = Math.max(0, centerY * viewScale - stage.clientHeight / 2);
    }
  }

  function setZoom(factor) {
    zoomFactor = Math.min(4, Math.max(1, factor));
    applyViewScale();
  }

  function setPencilMode(enabled, manual = false) {
    pencilOnly = enabled;
    if (manual) pencilModeManuallyOff = !enabled;
    $('#pencilOnly').checked = enabled;
    stage.classList.toggle('pencil-mode', enabled);
    if (!settingsPanel.classList.contains('settings-open')) {
      $('#mobileSettingsBtn').textContent = enabled ? '⚙ 설정 · 펜슬 모드' : '⚙ 설정 열기';
    }
    if (!enabled) { fingers.clear(); ignoredFingers.clear(); pinch = null; }
  }

  function midpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function beginPinch() {
    const [a, b] = [...fingers.values()];
    const center = midpoint(a, b);
    const rect = board.getBoundingClientRect();
    pinch = {
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      factor: zoomFactor,
      anchorX: (center.x - rect.left) / viewScale,
      anchorY: (center.y - rect.top) / viewScale,
    };
    for (const finger of fingers.values()) finger.hadPinch = true;
  }

  function updatePinch() {
    const [a, b] = [...fingers.values()];
    const center = midpoint(a, b);
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    zoomFactor = Math.min(4, Math.max(1, pinch.factor * distance / pinch.distance));
    applyViewScale(false);
    const rect = board.getBoundingClientRect();
    stage.scrollLeft += rect.left + pinch.anchorX * viewScale - center.x;
    stage.scrollTop += rect.top + pinch.anchorY * viewScale - center.y;
  }

  function focusCell(cell) {
    stage.scrollLeft = Math.max(0, cell.x1 * viewScale - 20);
    stage.scrollTop = Math.max(0, cell.y1 * viewScale - 84);
  }

  function closeSettings() {
    settingsPanel.classList.remove('settings-open');
    $('#settingsScrim').classList.remove('open');
    $('#mobileSettingsBtn').setAttribute('aria-expanded', 'false');
    $('#mobileSettingsBtn').textContent = pencilOnly ? '⚙ 설정 · 펜슬 모드' : '⚙ 설정 열기';
  }

  function canvasSize() {
    const [baseW, baseH] = baseSize();
    return [baseW, Math.max(baseH, state.height || 0)];
  }

  function resizeCanvas() {
    const [width, height] = canvasSize();
    board.width = width;
    board.height = height;
    page.style.width = `${width}px`;
    page.style.height = `${height}px`;
    controls.size.value = state.page;
    applyViewScale(false);
    render();
  }

  function updateHistoryButtons() {
    $('#undoBtn').disabled = history.length === 0;
    $('#redoBtn').disabled = future.length === 0;
  }

  function record(snapshot = copy(state)) {
    history.push(snapshot);
    if (history.length > 80) history.shift();
    future = [];
    updateHistoryButtons();
  }

  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      saveState.textContent = '방금 저장됨';
      clearTimeout(persist.timer);
      persist.timer = setTimeout(() => { saveState.textContent = '자동 저장 켜짐'; }, 1200);
    } catch (_) {
      saveState.textContent = '저장 공간 부족';
    }
  }

  function closeEditor(keepChanges) {
    if (!editor) return;
    if (keepChanges) {
      if (!editText.text.trim()) state.texts = state.texts.filter((item) => item !== editText);
      if (JSON.stringify(state) !== JSON.stringify(editSnapshot)) {
        record(editSnapshot);
        persist();
        status.textContent = '칸의 텍스트를 저장했습니다.';
      }
    } else {
      state = editSnapshot;
      selectedText = null;
      status.textContent = '입력을 취소했습니다.';
    }
    editor.remove();
    editor = editSnapshot = editText = editCell = null;
    selectedText = null;
    resizeCanvas();
  }

  function undo() {
    if (editor) { closeEditor(false); return; }
    if (!history.length) return;
    future.push(copy(state));
    state = history.pop();
    selectedText = null;
    resizeCanvas(); persist(); updateHistoryButtons();
    status.textContent = '마지막 작업을 되돌렸습니다.';
  }

  function redo() {
    if (editor) closeEditor(false);
    if (!future.length) return;
    history.push(copy(state));
    state = future.pop();
    selectedText = null;
    resizeCanvas(); persist(); updateHistoryButtons();
    status.textContent = '작업을 다시 적용했습니다.';
  }

  function pointer(event) {
    const rect = board.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(board.width, (event.clientX - rect.left) * board.width / rect.width)),
      y: Math.max(0, Math.min(board.height, (event.clientY - rect.top) * board.height / rect.height)),
    };
  }

  const snap = (value) => {
    const gap = Number(controls.grid.value);
    return gap ? Math.round(value / gap) * gap : Math.round(value);
  };

  function alignEnd(start, point) {
    let x = snap(point.x), y = snap(point.y);
    if (controls.align.checked) {
      const dx = x - start.x, dy = y - start.y;
      if (Math.abs(dy) < Math.abs(dx) * 0.18) y = start.y;
      else if (Math.abs(dx) < Math.abs(dy) * 0.18) x = start.x;
    }
    return { x, y };
  }

  function dash(style, width) {
    if (style === 'dashed') return [width * 4, width * 2.5];
    if (style === 'dotted') return [width, width * 2.6];
    return [];
  }

  function drawLine(line, target = ctx, ghost = false) {
    target.save();
    target.strokeStyle = ghost ? '#4d9c80' : (line.color || '#15302a');
    target.lineWidth = line.w || 2;
    target.lineCap = 'round';
    target.setLineDash(ghost ? [6, 5] : dash(line.style, line.w || 2));
    target.beginPath();
    target.moveTo(line.x1, line.y1);
    target.lineTo(line.x2, line.y2);
    target.stroke();
    target.restore();
  }

  function drawStroke(stroke, target = ctx, ghost = false) {
    if (!stroke.points || stroke.points.length < 2) return;
    target.save();
    target.strokeStyle = ghost ? '#4d9c80' : (stroke.color || '#15302a');
    target.lineWidth = stroke.w || 2;
    target.lineCap = 'round';
    target.lineJoin = 'round';
    target.beginPath();
    target.moveTo(stroke.points[0].x, stroke.points[0].y);
    stroke.points.slice(1).forEach((point) => target.lineTo(point.x, point.y));
    target.stroke();
    target.restore();
  }

  function wrappedRows(text, width, size, target = ctx) {
    target.save();
    target.font = `${size}px ui-sans-serif,system-ui,sans-serif`;
    const rows = [];
    for (const paragraph of text.split('\n')) {
      if (!paragraph) { rows.push(''); continue; }
      let row = '';
      for (const char of paragraph) {
        if (row && target.measureText(row + char).width > width) {
          rows.push(row);
          row = char;
        } else row += char;
      }
      rows.push(row);
    }
    target.restore();
    return rows;
  }

  function textRows(item, target = ctx) {
    return item.cell
      ? wrappedRows(item.text, Math.max(12, item.cell.x2 - item.cell.x1 - 20), item.size, target)
      : item.text.split('\n');
  }

  function drawText(item, target = ctx, selected = false) {
    target.save();
    const size = item.size || 20;
    target.font = `${size}px ui-sans-serif,system-ui,sans-serif`;
    target.textBaseline = 'top';
    const rows = textRows(item, target), step = size * 1.35;
    if (selected) {
      const box = item.cell || { x1: item.x - 5, x2: item.x + Math.max(...rows.map((r) => target.measureText(r).width)) + 5, y1: item.y - 4, y2: item.y + rows.length * step + 4 };
      target.fillStyle = '#dff4e8';
      target.fillRect(box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1);
    }
    target.fillStyle = '#102b23';
    rows.forEach((row, index) => {
      let x = item.x;
      if (item.cell) {
        const width = target.measureText(row).width;
        if (item.align === 'center') x = (item.cell.x1 + item.cell.x2 - width) / 2;
        else if (item.align === 'right') x = item.cell.x2 - 10 - width;
        else x = item.cell.x1 + 10;
      }
      target.fillText(row, x, item.y + index * step);
    });
    target.restore();
  }

  function drawGrid() {
    const gap = Number(controls.grid.value);
    if (!gap) return;
    ctx.save(); ctx.strokeStyle = '#e8eee9'; ctx.lineWidth = 1;
    for (let x = gap; x < board.width; x += gap) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, board.height); ctx.stroke();
    }
    for (let y = gap; y < board.height; y += gap) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(board.width, y); ctx.stroke();
    }
    ctx.restore();
  }

  function drawGuide() {
    if (!lineGuide) return;
    ctx.save();
    ctx.strokeStyle = '#e14c4c'; ctx.lineWidth = 2; ctx.setLineDash([7, 5]);
    ctx.beginPath(); ctx.moveTo(lineGuide.x1, lineGuide.y1);
    ctx.lineTo(lineGuide.x2, lineGuide.y2); ctx.stroke();
    ctx.restore();
  }

  function render() {
    ctx.clearRect(0, 0, board.width, board.height);
    ctx.fillStyle = '#fffef9'; ctx.fillRect(0, 0, board.width, board.height);
    drawGrid();
    state.lines.forEach((item) => drawLine(item));
    state.strokes.forEach((item) => drawStroke(item));
    state.texts.forEach((item) => drawText(item, ctx, item === selectedText));
    if (draftLine) drawLine(draftLine, ctx, true);
    if (draftStroke) drawStroke(draftStroke, ctx, true);
    drawGuide();
  }

  function equalLengthGuide(start, end) {
    lineGuide = null;
    const vertical = Math.abs(end.y - start.y) >= Math.abs(end.x - start.x);
    const candidates = state.lines.filter((item) => vertical
      ? Math.abs(item.x2 - item.x1) < 2
      : Math.abs(item.y2 - item.y1) < 2);
    if (!candidates.length) return end;
    const reference = candidates.reduce((best, item) => {
      const distance = vertical ? Math.abs(item.x1 - start.x) : Math.abs(item.y1 - start.y);
      return !best || distance < best.distance ? { item, distance } : best;
    }, null).item;
    const length = vertical ? Math.abs(reference.y2 - reference.y1) : Math.abs(reference.x2 - reference.x1);
    const desired = vertical
      ? start.y + Math.sign(end.y - start.y || 1) * length
      : start.x + Math.sign(end.x - start.x || 1) * length;
    if (vertical) lineGuide = { x1: reference.x1, y1: desired, x2: start.x, y2: desired };
    else lineGuide = { x1: desired, y1: reference.y1, x2: desired, y2: start.y };
    if (Math.abs((vertical ? end.y : end.x) - desired) <= 14) {
      return vertical ? { x: end.x, y: desired } : { x: desired, y: end.y };
    }
    return end;
  }

  function normalizedLine(item) {
    const vertical = Math.abs(item.x1 - item.x2) <= 3;
    const horizontal = Math.abs(item.y1 - item.y2) <= 3;
    if (vertical) return { axis: 'v', at: (item.x1 + item.x2) / 2, from: Math.min(item.y1, item.y2), to: Math.max(item.y1, item.y2) };
    if (horizontal) return { axis: 'h', at: (item.y1 + item.y2) / 2, from: Math.min(item.x1, item.x2), to: Math.max(item.x1, item.x2) };
    return null;
  }

  function lineCovers(segments, axis, at, from, to) {
    const spans = segments.filter((segment) => segment.axis === axis && Math.abs(segment.at - at) <= 3)
      .sort((a, b) => a.from - b.from);
    let covered = from;
    for (const span of spans) {
      if (span.from > covered + 4) return false;
      if (span.to > covered) covered = span.to;
      if (covered >= to - 4) return true;
    }
    return false;
  }

  function cellAt(point) {
    const segments = state.lines.map(normalizedLine).filter(Boolean);
    const xs = [...new Set(segments.filter((item) => item.axis === 'v').map((item) => Math.round(item.at)))].sort((a, b) => a - b);
    const ys = [...new Set(segments.filter((item) => item.axis === 'h').map((item) => Math.round(item.at)))].sort((a, b) => a - b);
    const lefts = xs.filter((x) => x < point.x - 2).reverse();
    const rights = xs.filter((x) => x > point.x + 2);
    const tops = ys.filter((y) => y < point.y - 2).reverse();
    const bottoms = ys.filter((y) => y > point.y + 2);
    let best = null;
    for (const x1 of lefts) for (const x2 of rights) {
      for (const y1 of tops) for (const y2 of bottoms) {
        if (!lineCovers(segments, 'v', x1, y1, y2) || !lineCovers(segments, 'v', x2, y1, y2)
          || !lineCovers(segments, 'h', y1, x1, x2) || !lineCovers(segments, 'h', y2, x1, x2)) continue;
        const area = (x2 - x1) * (y2 - y1);
        if (!best || area < best.area) best = { x1, y1, x2, y2, area };
      }
    }
    return best && { x1: best.x1, y1: best.y1, x2: best.x2, y2: best.y2 };
  }

  function sameCell(a, b) {
    return a && b && Math.abs(a.x1 - b.x1) <= 3 && Math.abs(a.y1 - b.y1) <= 3
      && Math.abs(a.x2 - b.x2) <= 3 && Math.abs(a.y2 - b.y2) <= 3;
  }

  function textAt(point) {
    for (let i = state.texts.length - 1; i >= 0; i--) {
      const item = state.texts[i];
      ctx.font = `${item.size || 20}px ui-sans-serif,system-ui,sans-serif`;
      const rows = textRows(item);
      const width = Math.max(...rows.map((row) => ctx.measureText(row).width));
      const height = rows.length * (item.size || 20) * 1.35;
      const box = item.cell || { x1: item.x - 8, x2: item.x + width + 8, y1: item.y - 8, y2: item.y + height + 8 };
      if (point.x >= box.x1 && point.x <= box.x2 && point.y >= box.y1 && point.y <= box.y2) return item;
    }
    return null;
  }

  function growRow(cell, delta) {
    if (delta <= 0) return;
    const border = cell.y2;
    const move = (y) => y >= border - 2 ? y + delta : y;
    state.lines.forEach((item) => { item.y1 = move(item.y1); item.y2 = move(item.y2); });
    state.strokes.forEach((item) => item.points.forEach((point) => { point.y = move(point.y); }));
    state.texts.forEach((item) => {
      item.y = move(item.y);
      if (item.cell) {
        item.cell.y1 = move(item.cell.y1);
        item.cell.y2 = move(item.cell.y2);
      }
    });
    cell.y2 += delta;
    const [, baseH] = baseSize();
    state.height = Math.max(baseH, (state.height || baseH) + delta);
    resizeCanvas();
  }

  function updateCellText() {
    if (!editor || !editText || !editCell) return;
    const area = editor.querySelector('textarea');
    const alignment = editor.querySelector('select').value;
    editText.text = area.value;
    editText.align = alignment;
    editText.size = Math.max(10, Math.min(72, Number(controls.font.value) || 20));
    editText.x = editCell.x1 + 10;
    editText.y = editCell.y1 + 10;
    editText.cell = { ...editCell };
    const rows = textRows(editText);
    const needed = Math.ceil(rows.length * editText.size * 1.35 + 20);
    const available = editCell.y2 - editCell.y1;
    if (needed > available) {
      growRow(editCell, Math.ceil((needed - available) / 10) * 10);
      editText.cell = { ...editCell };
    }
    editor.style.height = `${editCell.y2 - editCell.y1}px`;
    area.style.height = `${Math.max(36, editCell.y2 - editCell.y1 - 14)}px`;
    render();
  }

  function openCellEditor(cell) {
    if (editor) closeEditor(true);
    const existing = state.texts.find((item) => sameCell(item.cell, cell)
      || (!item.cell && item.x > cell.x1 && item.x < cell.x2 && item.y > cell.y1 && item.y < cell.y2));
    editSnapshot = copy(state);
    editCell = { ...cell };
    editText = existing || { x: cell.x1 + 10, y: cell.y1 + 10, text: '', size: Number(controls.font.value) || 20, align: 'left', cell: { ...cell } };
    if (!existing) state.texts.push(editText);
    selectedText = editText;
    editor = document.createElement('div');
    editor.className = 'cell-editor';
    editor.style.left = `${cell.x1}px`;
    editor.style.top = `${cell.y1}px`;
    editor.style.width = `${cell.x2 - cell.x1}px`;
    editor.style.height = `${cell.y2 - cell.y1}px`;
    editor.innerHTML = '<div class="cell-editor-tools"><label>정렬 <select aria-label="텍스트 정렬"><option value="left">왼쪽</option><option value="center">가운데</option><option value="right">오른쪽</option></select></label><button type="button" class="cell-done">완료</button><button type="button" class="cell-cancel">취소</button></div><textarea aria-label="선택한 칸의 텍스트" placeholder="이 칸에 입력"></textarea>';
    page.append(editor);
    if (mobileView()) {
      if (viewScale < 0.8) setZoom(0.8 / fitScale());
      focusCell(cell);
    }
    const area = editor.querySelector('textarea');
    area.value = editText.text;
    area.style.fontSize = `${editText.size}px`;
    area.style.height = `${Math.max(36, cell.y2 - cell.y1 - 14)}px`;
    area.style.textAlign = editText.align || 'left';
    editor.querySelector('select').value = editText.align || 'left';
    area.addEventListener('input', updateCellText);
    editor.querySelector('select').addEventListener('change', () => { area.style.textAlign = editor.querySelector('select').value; updateCellText(); });
    editor.querySelector('.cell-done').addEventListener('click', () => closeEditor(true));
    editor.querySelector('.cell-cancel').addEventListener('click', () => closeEditor(false));
    area.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); closeEditor(false); }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); closeEditor(true); }
    });
    render();
    area.focus();
    status.textContent = '칸에 직접 입력하세요. 글이 많아지면 행이 늘어납니다.';
  }

  function segmentDistance(point, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length));
    return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
  }

  function nearestStroke(point) {
    let best = null, distance = 16;
    state.lines.forEach((item) => {
      const current = segmentDistance(point, { x: item.x1, y: item.y1 }, { x: item.x2, y: item.y2 });
      if (current < distance) { distance = current; best = { list: 'lines', item }; }
    });
    state.strokes.forEach((item) => {
      for (let i = 1; i < item.points.length; i++) {
        const current = segmentDistance(point, item.points[i - 1], item.points[i]);
        if (current < distance) { distance = current; best = { list: 'strokes', item }; }
      }
    });
    return best;
  }

  function inkBounds(includeText) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    const add = (x, y, pad = 0) => { x1 = Math.min(x1, x - pad); y1 = Math.min(y1, y - pad); x2 = Math.max(x2, x + pad); y2 = Math.max(y2, y + pad); };
    state.lines.forEach((item) => { add(item.x1, item.y1, item.w / 2); add(item.x2, item.y2, item.w / 2); });
    state.strokes.forEach((item) => item.points.forEach((point) => add(point.x, point.y, item.w / 2)));
    if (includeText) state.texts.forEach((item) => {
      if (!item.text) return;
      ctx.font = `${item.size || 20}px ui-sans-serif,system-ui,sans-serif`;
      const rows = textRows(item);
      const width = Math.max(...rows.map((row) => ctx.measureText(row).width));
      add(item.cell ? item.cell.x1 : item.x, item.y);
      add(item.cell ? item.cell.x2 : item.x + width, item.y + rows.length * (item.size || 20) * 1.35);
    });
    return Number.isFinite(x1) ? { x1, y1, x2, y2 } : null;
  }

  function outputCanvas() {
    const includeText = document.querySelector('input[name="content"]:checked').value !== 'lines';
    const bounds = inkBounds(includeText);
    const margin = 24;
    const left = bounds ? Math.max(0, Math.floor(bounds.x1 - margin)) : 0;
    const top = bounds ? Math.max(0, Math.floor(bounds.y1 - margin)) : 0;
    const right = bounds ? Math.min(board.width, Math.ceil(bounds.x2 + margin)) : board.width;
    const bottom = bounds ? Math.min(board.height, Math.ceil(bounds.y2 + margin)) : board.height;
    const output = document.createElement('canvas');
    output.width = Math.max(1, right - left);
    output.height = Math.max(1, bottom - top);
    const target = output.getContext('2d');
    if (!controls.transparent.checked) { target.fillStyle = '#fffef9'; target.fillRect(0, 0, output.width, output.height); }
    target.translate(-left, -top);
    state.lines.forEach((item) => drawLine(item, target));
    state.strokes.forEach((item) => drawStroke(item, target));
    if (includeText) state.texts.filter((item) => item.text).forEach((item) => drawText(item, target));
    return output;
  }

  function setTool(next) {
    if (editor) closeEditor(true);
    tool = next;
    page.dataset.tool = next;
    document.querySelectorAll('.tool[data-tool]').forEach((button) => button.classList.toggle('active', button.dataset.tool === next));
    status.textContent = {
      line: '선을 드래그해서 표를 만드세요.', pen: '펜으로 자유롭게 그리세요.',
      text: '닫힌 사각형 칸을 눌러 직접 입력하세요.', select: '텍스트를 드래그해 옮기세요.',
      eraser: '지울 선 또는 펜 획을 누르세요.', pan: '캔버스를 드래그해 이동하세요.',
    }[next];
    if (mobileView()) closeSettings();
  }

  stage.addEventListener('pointerdown', (event) => {
    if (!pencilOnly || event.pointerType !== 'touch' || event.target.closest('.cell-editor')) return;
    event.preventDefault();
    event.stopPropagation();
    stage.setPointerCapture(event.pointerId);
    if (activePenPointerId !== null) { ignoredFingers.add(event.pointerId); return; }
    const finger = {
      x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY,
      scrollLeft: stage.scrollLeft, scrollTop: stage.scrollTop,
      onBoard: event.target === board, moved: false, hadPinch: false,
    };
    fingers.set(event.pointerId, finger);
    if (fingers.size === 2) beginPinch();
  }, true);

  stage.addEventListener('pointermove', (event) => {
    if (ignoredFingers.has(event.pointerId)) { event.preventDefault(); return; }
    const finger = fingers.get(event.pointerId);
    if (!finger) return;
    event.preventDefault();
    finger.x = event.clientX;
    finger.y = event.clientY;
    if (Math.hypot(finger.x - finger.startX, finger.y - finger.startY) > 8) finger.moved = true;
    if (fingers.size >= 2) {
      if (!pinch) beginPinch();
      updatePinch();
    } else if (finger.moved) {
      stage.scrollLeft = finger.scrollLeft - (finger.x - finger.startX);
      stage.scrollTop = finger.scrollTop - (finger.y - finger.startY);
    }
  });

  function endFinger(event, cancelled = false) {
    if (ignoredFingers.delete(event.pointerId)) { event.preventDefault(); return; }
    const finger = fingers.get(event.pointerId);
    if (!finger) return;
    event.preventDefault();
    fingers.delete(event.pointerId);
    if (!cancelled && !finger.moved && !finger.hadPinch && finger.onBoard) {
      const cell = cellAt(pointer(event));
      if (cell) openCellEditor(cell);
    }
    pinch = null;
    for (const remaining of fingers.values()) {
      remaining.startX = remaining.x;
      remaining.startY = remaining.y;
      remaining.scrollLeft = stage.scrollLeft;
      remaining.scrollTop = stage.scrollTop;
      remaining.hadPinch = true;
    }
  }

  stage.addEventListener('pointerup', endFinger);
  stage.addEventListener('pointercancel', (event) => endFinger(event, true));
  document.addEventListener('pointerup', (event) => {
    if (event.pointerId === activePenPointerId) activePenPointerId = null;
  });
  document.addEventListener('pointercancel', (event) => {
    if (event.pointerId === activePenPointerId) activePenPointerId = null;
  });

  board.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'pen') {
      activePenPointerId = event.pointerId;
      if (!pencilModeManuallyOff && !pencilOnly) setPencilMode(true);
      fingers.clear();
      pinch = null;
    }
    const point = pointer(event);
    if (tool === 'pan') {
      board.setPointerCapture(event.pointerId);
      panDrag = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
      return;
    }
    if (tool === 'text') {
      const cell = cellAt(point);
      if (cell) openCellEditor(cell);
      else status.textContent = '네 변이 닫힌 사각형 칸을 먼저 그려 주세요.';
      return;
    }
    board.setPointerCapture(event.pointerId);
    if (tool === 'line') {
      const start = { x: snap(point.x), y: snap(point.y) };
      draftLine = { x1: start.x, y1: start.y, x2: start.x, y2: start.y, w: Number(controls.width.value), color: controls.color.value, style: controls.style.value };
    } else if (tool === 'pen') {
      draftStroke = { points: [point], w: Number(controls.width.value), color: controls.color.value };
    } else if (tool === 'eraser') {
      const hit = nearestStroke(point);
      if (hit) { record(); state[hit.list] = state[hit.list].filter((item) => item !== hit.item); persist(); render(); status.textContent = '선을 지웠습니다.'; }
    } else if (tool === 'select') {
      selectedText = textAt(point);
      if (selectedText && !selectedText.cell) dragText = { item: selectedText, before: copy(state), startX: selectedText.x, startY: selectedText.y, dx: point.x - selectedText.x, dy: point.y - selectedText.y };
      render();
    }
  });

  board.addEventListener('pointermove', (event) => {
    if (panDrag) {
      stage.scrollLeft = panDrag.left - (event.clientX - panDrag.x);
      stage.scrollTop = panDrag.top - (event.clientY - panDrag.y);
      return;
    }
    const point = pointer(event);
    if (draftLine) {
      let end = alignEnd({ x: draftLine.x1, y: draftLine.y1 }, point);
      end = equalLengthGuide({ x: draftLine.x1, y: draftLine.y1 }, end);
      draftLine.x2 = end.x; draftLine.y2 = end.y;
      render();
    }
    if (draftStroke) { draftStroke.points.push(point); render(); }
    if (dragText) { dragText.item.x = snap(point.x - dragText.dx); dragText.item.y = snap(point.y - dragText.dy); render(); }
  });

  board.addEventListener('pointerup', (event) => {
    if (event.pointerId === activePenPointerId) activePenPointerId = null;
    panDrag = null;
    lineGuide = null;
    if (draftLine) {
      const finished = draftLine; draftLine = null;
      if (finished.x1 !== finished.x2 || finished.y1 !== finished.y2) { record(); state.lines.push(finished); persist(); status.textContent = '선을 추가했습니다.'; }
      render();
    }
    if (draftStroke) {
      const finished = draftStroke; draftStroke = null;
      if (finished.points.length > 1) { record(); state.strokes.push(finished); persist(); status.textContent = '펜 획을 추가했습니다.'; }
      render();
    }
    if (dragText) {
      if (dragText.item.x !== dragText.startX || dragText.item.y !== dragText.startY) {
        record(dragText.before); persist();
      }
      dragText = null; render();
    }
  });
  board.addEventListener('pointercancel', (event) => {
    if (event.pointerId === activePenPointerId) activePenPointerId = null;
    draftLine = draftStroke = dragText = lineGuide = panDrag = null; render();
  });

  document.querySelectorAll('.tool[data-tool]').forEach((button) => button.addEventListener('click', () => setTool(button.dataset.tool)));
  $('#zoomOut').addEventListener('click', () => setZoom(zoomFactor / 1.5));
  $('#zoomIn').addEventListener('click', () => setZoom(zoomFactor * 1.5));
  $('#zoomReset').addEventListener('click', () => setZoom(1));
  $('#pencilOnly').addEventListener('change', (event) => setPencilMode(event.target.checked, true));
  $('#mobileSettingsBtn').addEventListener('click', () => {
    const open = settingsPanel.classList.toggle('settings-open');
    $('#settingsScrim').classList.toggle('open', open);
    $('#mobileSettingsBtn').setAttribute('aria-expanded', String(open));
    $('#mobileSettingsBtn').textContent = open ? '설정 닫기' : (pencilOnly ? '⚙ 설정 · 펜슬 모드' : '⚙ 설정 열기');
  });
  $('#settingsScrim').addEventListener('click', closeSettings);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && settingsPanel.classList.contains('settings-open')) closeSettings(); });
  controls.color.addEventListener('input', () => { $('#colorHex').textContent = controls.color.value.toUpperCase(); });
  controls.width.addEventListener('input', () => { $('#lineWidthLabel').textContent = `${controls.width.value} px`; });
  controls.grid.addEventListener('change', render);
  controls.font.addEventListener('change', () => { if (editor) updateCellText(); });
  controls.size.addEventListener('change', () => { if (editor) closeEditor(true); record(); state.page = controls.size.value; resizeCanvas(); persist(); status.textContent = '페이지 크기를 바꿨습니다.'; });
  $('#undoBtn').addEventListener('click', undo);
  $('#redoBtn').addEventListener('click', redo);
  $('#deleteTextBtn').addEventListener('click', () => {
    if (!selectedText) { status.textContent = '삭제할 텍스트를 먼저 선택하세요.'; return; }
    record(); state.texts = state.texts.filter((item) => item !== selectedText); selectedText = null; persist(); render();
  });
  $('#clearBtn').addEventListener('click', () => {
    if (editor) closeEditor(true);
    if (!state.lines.length && !state.strokes.length && !state.texts.length) return;
    if (!confirm('캔버스의 선, 펜 획, 텍스트를 모두 지울까요?')) return;
    record(); state.lines = []; state.strokes = []; state.texts = []; state.height = undefined; selectedText = null;
    resizeCanvas(); persist(); status.textContent = '새 캔버스가 준비되었습니다.';
  });
  $('#pngBtn').addEventListener('click', () => {
    if (editor) closeEditor(true);
    const link = document.createElement('a');
    link.href = outputCanvas().toDataURL('image/png');
    link.download = controls.transparent.checked ? 'sunpyo-transparent.png' : 'sunpyo-table.png';
    link.click(); status.textContent = 'PNG 파일을 저장했습니다.';
  });
  $('#pdfBtn').addEventListener('click', () => {
    if (editor) closeEditor(true);
    const image = outputCanvas().toDataURL('image/png');
    const [width, height] = canvasSize();
    const popup = window.open('', '_blank');
    if (!popup) { alert('PDF 저장을 위해 팝업을 허용해 주세요.'); return; }
    popup.document.write(`<!doctype html><title>선표 PDF</title><style>@page{size:${width > height ? 'landscape' : 'portrait'};margin:8mm}body{margin:0}img{width:100%;height:auto}</style><img src="${image}" onload="print()">`);
    popup.document.close(); status.textContent = '인쇄 창에서 “PDF로 저장”을 선택하세요.';
  });
  document.addEventListener('keydown', (event) => {
    if (editor && event.target.closest('.cell-editor')) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selectedText && document.activeElement === document.body) $('#deleteTextBtn').click();
  });

  resizeCanvas(); updateHistoryButtons();
  if ('ResizeObserver' in window) new ResizeObserver(() => applyViewScale()).observe(stage);
  else window.addEventListener('resize', () => applyViewScale());
})();
