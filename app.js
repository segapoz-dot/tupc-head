// Логика страницы: связывает поля ввода, расчёт (kinematics.js) и 3D (head3d.js).
import * as K from './kinematics.js';
import { HeadView } from './head3d.js';
import { runProgram, SAMPLES } from './gcode.js';

const $ = (id) => document.getElementById(id);
const fmt = (x) => K.round3(x).toFixed(3);
const fmtv = (v) => `i ${fmt(v[0])}   j ${fmt(v[1])}   k ${fmt(v[2])}`;

// --- сохранение размеров (только у этого пользователя, не обязательно)
function loadGeom() {
  try { const g = JSON.parse(localStorage.getItem('tupc-geom2')); if (g && g.d1 > 0) return { ...K.DEFAULT_GEOM, ...g }; } catch (e) {}
  return { ...K.DEFAULT_GEOM };
}
function saveGeom(g) { try { localStorage.setItem('tupc-geom2', JSON.stringify(g)); } catch (e) {} }

let geom = loadGeom();
const view = new HeadView($('view'));
view.setGeom(geom);

let state = { a: 0, b: 0 }; // заданное положение (куда поставили голову)

// Живые цифры в углу 3D во время поворота
view.onFrame = (a, b) => {
  $('hudA').textContent = fmt(a);
  $('hudB').textContent = fmt(b);
  $('hudV').textContent = fmtv(K.toolDir(a, b));
};

// Поставить голову и обновить всё
function setHead(a, b, { animate = $('smooth').checked, from = '' } = {}) {
  a = K.norm360(a); b = K.norm180(b);
  if (Math.abs(b + 180) < 1e-9) b = 180;
  state = { a, b };
  view.setAngles(a, b, animate);
  if (from !== 'slider') {
    $('rA').value = a; $('rB').value = b;
  }
  if (from !== 'num') { $('nA').value = K.round3(a); $('nB').value = K.round3(b); }
  showResult();
}

function showResult() {
  const { a, b } = state;
  const t = K.toolDir(a, b);
  $('resA').textContent = fmt(a);
  $('resB').textContent = fmt(b);
  $('resV').textContent = 'Вектор: ' + fmtv(t);
  $('resD').textContent = 'Инструмент смотрит ' + K.describeDir(t);
  const f = K.dirToFrame(t);
  $('codeM20').textContent = K.m20Line(a, b);
  $('codeDir').textContent = K.cycle800Direct(a, b);
  $('codeAx').textContent = K.cycle800Axis(f.A, f.B, 0);
  showPoints();
}

function showPoints() {
  const { a, b } = state;
  const tip = K.tipFromRef([0, 0, 0], a, b, geom);
  $('tipOut').textContent = `X ${fmt(tip[0])}   Y ${fmt(tip[1])}   Z ${fmt(tip[2])}`;
  const tp = [+$('tX').value || 0, +$('tY').value || 0, +$('tZ').value || 0];
  const M = K.refFromTip(tp, a, b, geom);
  $('refOut').textContent = `Торец ползуна: X ${fmt(M[0])}   Y ${fmt(M[1])}   Z ${fmt(M[2])}`;
}

// --- вкладки
const tabs = [...document.querySelectorAll('#tabs button')];
tabs.forEach((btn) => btn.addEventListener('click', () => {
  tabs.forEach((x) => x.classList.toggle('on', x === btn));
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x.id === 'tab-' + btn.dataset.tab));
  // Подставить текущее положение в поля вкладки
  const t = K.toolDir(state.a, state.b);
  if (btn.dataset.tab === 'vec') { $('vI').value = K.round3(t[0]); $('vJ').value = K.round3(t[1]); $('vK').value = K.round3(t[2]); }
  if (btn.dataset.tab === 'cyc') { const f = K.dirToFrame(t); $('cA').value = K.round3(f.A); $('cB').value = K.round3(f.B); $('cC').value = 0; }
}));

// --- вкладка «Углы»
$('rA').addEventListener('input', () => setHead(+$('rA').value, state.b, { animate: false, from: 'slider' }));
$('rB').addEventListener('input', () => setHead(state.a, +$('rB').value, { animate: false, from: 'slider' }));
for (const id of ['nA', 'nB']) {
  $(id).addEventListener('change', () => setHead(+$('nA').value || 0, +$('nB').value || 0, { from: 'num' }));
}
document.querySelectorAll('#presets button').forEach((btn) =>
  btn.addEventListener('click', () => setHead(+btn.dataset.a, +btn.dataset.b)));

// --- решения (для вкладок «Вектор» и «CYCLE800»)
function showSolutions(box, t) {
  const s = K.solveAB(t);
  box.innerHTML = '';
  if (!s.ok) {
    const e = document.createElement('div'); e.className = 'err'; e.textContent = s.reason; box.appendChild(e);
    if (s.nearest) {
      const n = document.createElement('div'); n.className = 'note';
      n.textContent = 'Ближайшее, что можно: ' + fmtv(s.nearest);
      box.appendChild(n);
    }
    return;
  }
  const wrap = document.createElement('div'); wrap.className = 'sols';
  const btns = s.solutions.map((x, i) => {
    const b = document.createElement('button');
    b.innerHTML = `<b>Решение ${i + 1}:</b> &nbsp;a = ${fmt(x.a)}°, &nbsp;b = ${fmt(x.b)}°`;
    b.addEventListener('click', () => { btns.forEach((y) => y.classList.toggle('on', y === b)); setHead(x.a, x.b); });
    wrap.appendChild(b); return b;
  });
  box.appendChild(wrap);
  const n = document.createElement('div'); n.className = 'note';
  n.textContent = s.free ? s.reason
    : s.solutions.length > 1 ? 'Два способа встать в одно направление: инструмент смотрит одинаково, но корпус развёрнут иначе (смотри жёлтую метку). Нажми, чтобы показать.'
    : 'Одно решение.';
  box.appendChild(n);
  btns[0].click();
}
$('goVec').addEventListener('click', () => showSolutions($('vecOut'), [+$('vI').value || 0, +$('vJ').value || 0, +$('vK').value || 0]));
$('goCyc').addEventListener('click', () => showSolutions($('cycOut'), K.frameToDir(+$('cA').value || 0, +$('cB').value || 0, +$('cC').value || 0)));
for (const id of ['vI', 'vJ', 'vK']) $(id).addEventListener('keydown', (e) => e.key === 'Enter' && $('goVec').click());
for (const id of ['cA', 'cB', 'cC']) $(id).addEventListener('keydown', (e) => e.key === 'Enter' && $('goCyc').click());

// --- размеры головы
$('gD1').value = geom.d1; $('gH').value = geom.h; $('gD2').value = geom.d2; $('gL').value = geom.L;
for (const id of ['gD1', 'gH', 'gD2', 'gL']) $(id).addEventListener('change', () => {
  const g = { d1: +$('gD1').value, h: +$('gH').value, d2: +$('gD2').value, L: +$('gL').value };
  if (!(g.d1 > 0 && g.h >= 0 && g.d2 >= 0 && g.L > 0)) return;
  geom = g; saveGeom(g); view.setGeom(g); showPoints(); if (prg.res) loadProgram();
});
for (const id of ['tX', 'tY', 'tZ']) $(id).addEventListener('input', showPoints);
$('rC').addEventListener('input', () => { $('nC').value = $('rC').value; view.setTableC(+$('rC').value); });
$('nC').addEventListener('change', () => { $('rC').value = $('nC').value; view.setTableC(+$('nC').value || 0); });

// --- кнопки вида и копирования
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => view.setView(b.dataset.view)));
document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
  const text = $(b.dataset.copy).textContent;
  try { await navigator.clipboard.writeText(text); }
  catch (e) { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
  const old = b.textContent; b.textContent = '✓'; setTimeout(() => (b.textContent = old), 900);
}));


// ================= Программа (G-код) =================
const prg = { res: null, i: 0, t: 0, running: false, M0: [0, 0, 0], lastTip: null, lineEls: [] };
const speedMul = () => Math.pow(2, +$('pSpeed').value);
$('pText').value = SAMPLES.sides;
$('pSample').addEventListener('change', () => { $('pText').value = SAMPLES[$('pSample').value]; loadProgram(); });
$('pFileBtn').addEventListener('click', () => $('pFile').click());
$('pFile').addEventListener('change', () => {
  const f = $('pFile').files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => { $('pText').value = String(r.result); $('pEditBox').open = true; loadProgram(); };
  r.readAsText(f);
});
$('pSpeed').addEventListener('input', () => { $('pSpeedV').textContent = '×' + K.round3(speedMul()); });

function loadProgram() {
  const size = [+$('pSX').value || 860, +$('pSY').value || 500, +$('pSZ').value || 420];
  view.setPart(size);
  const W = view.partZero();
  const reach = geom.h + geom.d2 + geom.L;
  const top = W[2] + size[2] / 2;
  prg.M0 = K.refFromTip([W[0], W[1], top + 500], 0, 0, geom); // старт: инструмент вниз, на 500 над деталью
  const res = prg.res = runProgram($('pText').value, { geom, W, parkZ: top + 500 + reach, startA: 0, startB: 0, startM: prg.M0 });
  view.clearPath(); view.setPath(res.rapid, res.feed);
  // листинг
  const box = $('pList'); box.innerHTML = '';
  const lvl = {}; for (const m of res.msgs) if (m.level !== 'info') lvl[m.line] = m.level === 'error' ? 'error' : (lvl[m.line] || 'warn');
  prg.lineEls = $('pText').value.replace(/\r/g, '').split('\n').map((t, i) => {
    const d = document.createElement('div'); d.textContent = t || ' ';
    if (/^\s*;/.test(t)) d.classList.add('cm');
    if (lvl[i]) d.classList.add(lvl[i]);
    d.title = res.msgs.filter((m) => m.line === i).map((m) => m.text).join('\n');
    d.addEventListener('click', () => runTo(i));
    box.appendChild(d); return d;
  });
  const mb = $('pMsgs'); mb.innerHTML = '';
  for (const m of res.msgs.filter((x) => x.level !== 'info')) {
    const d = document.createElement('div'); d.className = m.level;
    d.textContent = `стр. ${m.line + 1}: ${m.text}`; mb.appendChild(d);
  }
  const moves = res.steps.filter((x) => x.pts).length, rots = res.steps.filter((x) => x.kind === 'rotate').length;
  $('pNow').textContent = `Разобрано: ${moves} перемещений, ${rots} поворотов головы. Жми «Пуск» или «Шаг».`;
  ['pPlay', 'pStep', 'pReset'].forEach((id) => ($(id).disabled = !res.steps.length));
  resetProgram();
  view.focusPart(); view.setView('3d');
}
$('pLoad').addEventListener('click', loadProgram);

function resetProgram() {
  if (prg.res) for (const st of prg.res.steps) st._k = 0;
  prg.i = 0; prg.t = 0; prg.running = false; $('pPlay').textContent = '▶ Пуск';
  view.trailReset(); view.setTableC(0); $('rC').value = 0; $('nC').value = 0;
  view.setRef(prg.M0); setHead(0, 0, { animate: false });
  prg.lastTip = K.tipFromRef(prg.M0, 0, 0, geom);
  markLine(-1);
}
$('pReset').addEventListener('click', resetProgram);
$('pPlay').addEventListener('click', () => {
  if (!prg.res) return;
  if (prg.i >= prg.res.steps.length) resetProgram();
  prg.running = !prg.running; $('pPlay').textContent = prg.running ? '⏸ Пауза' : '▶ Пуск';
});
$('pStep').addEventListener('click', () => { prg.running = false; $('pPlay').textContent = '▶ Пуск'; finishStep(); });

function runTo(line) { // щёлкнули по строке — быстро прогнать до неё
  if (!prg.res) return;
  resetProgram();
  while (prg.i < prg.res.steps.length && prg.res.steps[prg.i].line <= line) finishStep();
}

function stepDur(s) {
  if (s.kind === 'rotate') return Math.max(0.3, Math.max(Math.abs(s.a1 - s.a0), Math.abs(s.b1 - s.b0)) / 90);
  if (s.kind === 'table') return Math.max(0.3, Math.abs(s.c1 - s.c0) / 90);
  if (!s.len) { s.cum = [0]; for (let k = 1; k < s.pts.length; k++) s.cum.push(s.cum[k - 1] + Math.hypot(...[0, 1, 2].map((j) => s.pts[k][j] - s.pts[k - 1][j]))); s.len = s.cum[s.cum.length - 1]; }
  return Math.max(0.12, s.len / (s.kind === 'rapid' ? 3000 : 500));
}
function applyStep(s, t) {
  if (s.kind === 'rotate') {
    const a = s.a0 + (s.a1 - s.a0) * t, b = s.b0 + (s.b1 - s.b0) * t;
    view.setRef(s.M); view.setAngles(a, b, false);
    prg.lastTip = K.tipFromRef(s.M, a, b, geom);
  } else if (s.kind === 'table') {
    const c = s.c0 + (s.c1 - s.c0) * t; view.setTableC(c); $('nC').value = K.round3(c); $('rC').value = c;
  } else {
    stepDur(s);
    const d = s.len * t; let k = 1; while (k < s.cum.length - 1 && s.cum[k] < d) k++;
    const seg = s.cum[k] - s.cum[k - 1], f = seg > 0 ? (d - s.cum[k - 1]) / seg : 1;
    const p = s.pts[k - 1].map((v, j) => v + (s.pts[k][j] - v) * f);
    // все пройденные вершины ломаной (дуги) — в след, потом кусок до текущей точки
    s._k = s._k || 0;
    while (s._k + 1 < s.pts.length && s.cum[s._k + 1] <= d + 1e-9) { s._k++; view.trailAdd(prg.lastTip, s.pts[s._k]); prg.lastTip = s.pts[s._k]; }
    if (d < s.len - 1e-9) { view.trailAdd(prg.lastTip, p); prg.lastTip = p; }
    view.setAngles(s.a, s.b, false);
    view.setRef(K.refFromTip(p, s.a, s.b, geom));
  }
}
function finishStep() {
  const s = prg.res && prg.res.steps[prg.i]; if (!s) return;
  applyStep(s, 1); endStep(s);
}
function endStep(s) {
  prg.i++; prg.t = 0;
  markLine(s.line);
  if (s.kind === 'rotate') { state = { a: K.norm360(s.a1), b: s.b1 }; $('nA').value = K.round3(state.a); $('nB').value = K.round3(state.b); $('rA').value = state.a; $('rB').value = state.b; showResult(); }
  if (prg.i >= prg.res.steps.length) { prg.running = false; $('pPlay').textContent = '▶ Пуск'; $('pNow').textContent += '   — конец программы'; }
}
function markLine(line) {
  prg.lineEls.forEach((el, i) => el.classList.toggle('cur', i === line));
  const el = prg.lineEls[line];
  if (el) { el.scrollIntoView({ block: 'nearest' }); }
  const s = prg.res && prg.res.steps[prg.i - 1];
  const txt = line >= 0 && prg.lineEls[line] ? prg.lineEls[line].textContent.trim() : '';
  let pos = '';
  if (s && s.pos) pos = `\nX ${fmt(s.pos[0])}  Y ${fmt(s.pos[1])}  Z ${fmt(s.pos[2])}`;
  $('pNow').textContent = txt ? txt + pos : 'Начало программы';
  $('hudLine').hidden = !txt; $('hudLine').textContent = txt;
}
let lastT = performance.now();
function loop(now) {
  const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
  if (prg.running && prg.res) {
    let left = dt * speedMul();
    while (left > 0 && prg.i < prg.res.steps.length) {
      const s = prg.res.steps[prg.i], D = stepDur(s);
      const need = (1 - prg.t) * D;
      if (left >= need) { left -= need; finishStep(); }
      else { prg.t += left / D; applyStep(s, prg.t); left = 0; }
    }
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

setHead(0, 0, { animate: false });
window.__tupc = { K, view, setHead, prg, loadProgram }; // для отладки из консоли
