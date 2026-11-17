// Логика страницы: связывает поля ввода, расчёт (kinematics.js) и 3D (head3d.js).
import * as K from './kinematics.js';
import { HeadView } from './head3d.js';

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
  geom = g; saveGeom(g); view.setGeom(g); showPoints();
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

setHead(0, 0, { animate: false });
window.__tupc = { K, view, setHead }; // для отладки из консоли
