// Чтение программы Sinumerik 840D (под голову TUPC) и расчёт движения — без 3D.
// На выходе — список шагов: «повернуть голову», «ехать», «повернуть стол», с координатами вершины инструмента.
//
// Системы координат:
//   p   — программные координаты (то, что написано в X Y Z после всех поворотов);
//   wp  — координаты детали (G54): ноль детали, оси станка;
//   мир — координаты 3D-сцены (как в kinematics.js): world = W + Rz(COMPTAB)·wp, W — где лежит ноль детали.
// Цепочка кадров:  wp = X0 + Rc·(X1 + T + Rp·p)
//   Rc, X0, X1 — от CYCLE800 (поворот плоскости, точка отсчёта, ноль после поворота);
//   T, Rp      — программируемые TRANS/ATRANS и ROT/AROT.
import * as K from './kinematics.js';

const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const tr = (m) => [0, 1, 2].map((i) => [m[0][i], m[1][i], m[2][i]]);
const add = (u, v) => [u[0] + v[0], u[1] + v[1], u[2] + v[2]];
const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
const lerp = (u, v, t) => [u[0] + (v[0] - u[0]) * t, u[1] + (v[1] - u[1]) * t, u[2] + (v[2] - u[2]) * t];
const AX = { X: 0, Y: 1, Z: 2 };
const ROTS = [null, K.rotX, K.rotY, K.rotZ];
// Плоскость: [u, v, нормаль]. G2 — по часовой, если смотреть с конца нормали.
const PLANES = { 17: [0, 1, 2], 18: [2, 0, 1], 19: [1, 2, 0] };

// Циклы, которые пока не рисуем (шаг 2), но узнаём
const KNOWN_CYCLES = /^(CYCLE\d+|POCKET\d|HOLES\d|SLOT\d|LONGHOLE)$/;

// ---------- разбор одной строки ----------
function splitArgs(s) {
  const out = []; let cur = '', q = false;
  for (const ch of s) {
    if (ch === '"') { q = !q; cur += ch; continue; }
    if (ch === ',' && !q) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => {
    const t = x.trim();
    if (t === '') return undefined;
    if (t.startsWith('"')) return t.replace(/^"|"$/g, '');
    const n = Number(t); return Number.isFinite(n) ? n : t;
  });
}

export function parseBlock(raw) {
  // комментарий после «;» (не внутри кавычек)
  let code = '', q = false;
  for (const ch of raw) { if (ch === '"') q = !q; if (ch === ';' && !q) break; code += ch; }
  const comment = raw.slice(code.length + 1).trim();
  // В верхний регистр всё, кроме текста в кавычках
  let s = code.replace(/("[^"]*")|([^"]+)/g, (m, str, rest) => (str ? str : rest.toUpperCase()));
  const b = { raw, comment, calls: [], words: {}, g: [], m: [], kw: new Set(), tName: null, n: null, axes: {}, empty: false };

  s = s.replace(/\b(MCALL\s+)?([A-Z_][A-Z0-9_]*)\s*\(([^()]*)\)/g, (_, mc, name, args) => {
    b.calls.push({ name, args: splitArgs(args), mcall: !!mc }); return ' ';
  });
  s = s.replace(/\bT\s*=\s*"([^"]*)"/g, (_, n) => { b.tName = n; return ' '; });
  s = s.replace(/\bM(\d+)\s*=\s*(\d+)/g, (_, a, v) => { b.m.push(`${a}=${v}`); return ' '; });
  s = s.replace(/\b([A-Z]{2,}[A-Z0-9_]*)\s*=\s*([-+]?[\d.]+)/g, (_, n, v) => { b.words[n] = +v; return ' '; });
  s = s.replace(/\b([A-Z]{2,}[A-Z0-9_]*)\b/g, (_, k) => { b.kw.add(k); return ' '; });
  const re = /([A-Z])\s*=?\s*([-+]?(?:\d+\.?\d*|\.\d+))/g; let mt;
  while ((mt = re.exec(s))) {
    const L = mt[1], v = +mt[2];
    if (L === 'N') b.n = v;
    else if (L === 'G') b.g.push(v);
    else if (L === 'M') b.m.push(String(v));
    else if ('XYZ'.includes(L)) b.axes[L] = v;
    else b.words[L] = v; // I J K F S T D C A B …
  }
  b.empty = !b.calls.length && !b.g.length && !b.m.length && !b.kw.size && !Object.keys(b.axes).length
    && !Object.keys(b.words).length && !b.tName;
  return b;
}

// ---------- прогон программы ----------
// opts: { geom, W:[x,y,z] — ноль детали в мире, parkZ — высота отвода по SUPA (мир),
//         startA, startB, startM — где голова до начала }
export function runProgram(text, opts) {
  const geom = opts.geom || K.DEFAULT_GEOM;
  const W = opts.W || [0, 0, 0];
  const lines = text.replace(/\r/g, '').split('\n');
  const steps = [], msgs = [], rapid = [], feed = [];
  const msg = (line, text, level = 'info') => msgs.push({ line, text, level });

  const st = {
    motion: 0, plane: 17, abs: true,
    a: opts.startA ?? 0, b: opts.startB ?? 0, C: 0,
    M: opts.startM ? [...opts.startM] : [0, 0, 0],
    Rc: I3, X0: [0, 0, 0], X1: [0, 0, 0], T: [0, 0, 0], Rp: I3, comptab: 0,
    tool: null, d: 0, mcall: null,
  };
  const Rz = () => K.rotZ(st.comptab);
  const toWorld = (p) => {
    const inner = add(add(st.X1, st.T), K.matVec(st.Rp, p));
    const wp = add(st.X0, K.matVec(st.Rc, inner));
    return add(W, K.matVec(Rz(), wp));
  };
  const toProg = (w) => {
    const wp = K.matVec(tr(Rz()), sub(w, W));
    const inner = K.matVec(tr(st.Rc), sub(wp, st.X0));
    return K.matVec(tr(st.Rp), sub(sub(inner, st.X1), st.T));
  };
  const tip = () => K.tipFromRef(st.M, st.a, st.b, geom);
  const progNow = () => toProg(tip());

  // Голова: повернуть корпуса (ползун стоит, вершина описывает дугу)
  function rotateHead(line, a, b, why) {
    a = K.norm360(a); b = K.norm180(b); if (Math.abs(b + 180) < 1e-9) b = 180;
    if (Math.abs(K.norm180(a - st.a)) < 1e-9 && Math.abs(b - st.b) < 1e-9) return;
    steps.push({ line, kind: 'rotate', a0: st.a, b0: st.b, a1: a, b1: b, M: [...st.M], why });
    st.a = a; st.b = b;
  }
  // Ехать: список точек вершины в мире
  function move(line, kind, pts) {
    if (pts.length < 2) return;
    const seg = kind === 'rapid' ? rapid : feed;
    for (let i = 1; i < pts.length; i++) seg.push(pts[i - 1], pts[i]);
    steps.push({ line, kind, pts, a: st.a, b: st.b, pos: toProg(pts[pts.length - 1]) });
    st.M = K.refFromTip(pts[pts.length - 1], st.a, st.b, geom);
  }

  function arcPoints(line, p0, p1, b, cw) {
    const [u, v, w] = PLANES[st.plane];
    const off = [b.words.I || 0, b.words.J || 0, b.words.K || 0];
    if (b.words.CR !== undefined) { msg(line, 'Дуга через CR= пока не поддерживается — нарисована прямой', 'warn'); return [p0, p1]; }
    const c = add(p0, off);
    const r0 = Math.hypot(p0[u] - c[u], p0[v] - c[v]), r1 = Math.hypot(p1[u] - c[u], p1[v] - c[v]);
    if (r0 < 1e-6) { msg(line, 'Дуга без центра (нет I/J/K) — нарисована прямой', 'warn'); return [p0, p1]; }
    if (Math.abs(r0 - r1) > 0.05) msg(line, `Радиус в начале ${K.round3(r0)} и в конце ${K.round3(r1)} не совпадают`, 'warn');
    const a0 = Math.atan2(p0[v] - c[v], p0[u] - c[u]), a1 = Math.atan2(p1[v] - c[v], p1[u] - c[u]);
    const TAU = Math.PI * 2;
    let sweep = cw ? a0 - a1 : a1 - a0;
    sweep = ((sweep % TAU) + TAU) % TAU;
    if (sweep < 1e-9) sweep = TAU; // начало = конец → полный круг
    const n = Math.min(720, Math.max(12, Math.ceil(sweep * r0 / 4)));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, ang = a0 + (cw ? -1 : 1) * sweep * t, r = r0 + (r1 - r0) * t;
      const p = [0, 0, 0];
      p[u] = c[u] + r * Math.cos(ang); p[v] = c[v] + r * Math.sin(ang); p[w] = p0[w] + (p1[w] - p0[w]) * t;
      pts.push(p);
    }
    pts[pts.length - 1] = p1;
    return pts;
  }

  function cycle800(line, args) {
    if (!args.length || (args.length === 1 && args[0] === undefined)) {
      st.Rc = I3; st.X0 = [0, 0, 0]; st.X1 = [0, 0, 0];
      msg(line, 'CYCLE800() — наклон плоскости снят, голова осталась как стоит'); return;
    }
    const g = (i) => (typeof args[i] === 'number' ? args[i] : 0);
    const mode = g(3), type = (mode >> 6) & 3, dir = g(13) || -1, ST = g(2);
    const A = g(7), B = g(8), C = g(9);
    const X0 = [g(4), g(5), g(6)], X1 = [g(10), g(11), g(12)];
    if (args[1] !== undefined && String(args[1]).toUpperCase() !== 'TUPC') msg(line, `Набор поворота «${args[1]}» — считаю как TUPC`, 'warn');
    if (ST % 10 === 1 && !st.comptab) msg(line, 'CYCLE800 с 100001 (под COMPTAB), а COMPTAB не включён', 'warn');
    let R, a, b;
    if (type === 3) { // «прямо»: углы корпусов
      a = A; b = B; R = K.body2Matrix(a, b);
    } else if (type === 0) { // «ось за осью»
      const seq = [mode & 3, (mode >> 2) & 3, (mode >> 4) & 3];
      if (seq.some((x) => x === 0)) { msg(line, `Непонятный порядок осей в режиме ${mode}`, 'error'); return; }
      R = [A, B, C].reduce((m, ang, i) => K.matMul(m, ROTS[seq[i]](ang)), I3);
      const t = K.matVec(R, [0, 0, -1]);
      const s = K.solveAB(t);
      if (!s.ok) { msg(line, 'CYCLE800: голова так встать не может — ' + s.reason, 'error'); return; }
      const pick = s.solutions.length > 1 ? s.solutions[dir < 0 ? 0 : 1] : s.solutions[0];
      ({ a, b } = pick);
      if (s.solutions.length > 1) msg(line, `CYCLE800: два решения, взято a=${K.round3(a)} b=${K.round3(b)} (какое берёт стойка — уточнить)`);
    } else {
      msg(line, 'CYCLE800: режимы «телесный угол» и «проекция» пока не поддерживаются', 'error'); return;
    }
    st.Rc = R; st.X0 = X0; st.X1 = X1;
    rotateHead(line, a, b, 'CYCLE800');
  }

  lines.forEach((raw, line) => {
    if (!raw.trim()) return;
    let b;
    try { b = parseBlock(raw); } catch (e) { msg(line, 'Не понял строку: ' + e.message, 'error'); return; }
    if (b.empty) return;

    // G-функции
    for (const g of b.g) {
      if (g <= 3) st.motion = g;
      else if (g === 17 || g === 18 || g === 19) st.plane = g;
      else if (g === 90) st.abs = true;
      else if (g === 91) st.abs = false;
      else if (g === 70) msg(line, 'G70 (дюймы) — считаю всё равно в мм', 'warn');
      else if (g === 54 || g === 55 || g === 56 || g === 57 || g === 500 || (g >= 505 && g <= 599)) {
        if (g !== 54) msg(line, `G${g}: ноль детали беру тот же, что и G54 (значений смещений я не знаю)`);
      }
    }
    if (b.kw.has('LATHEON') || b.calls.some((c) => c.name === 'LATHEON')) msg(line, 'Токарный режим (LATHEON) пока не показывается', 'warn');
    if (b.tName || b.words.T !== undefined) { st.tool = b.tName ?? b.words.T; msg(line, `Инструмент ${st.tool}`); }
    if (b.m.includes('6')) msg(line, 'Смена инструмента (M6)');
    if (b.m.includes('30') || b.m.includes('17')) msg(line, 'Конец программы');

    // Вызовы
    for (const c of b.calls) {
      if (c.name === 'M_20') rotateHead(line, c.args[0] || 0, c.args[1] || 0, 'M_20');
      else if (c.name === 'CYCLE800') cycle800(line, c.args);
      else if (c.name === 'COMPTAB') { st.comptab = +c.args[0] || 0; msg(line, `COMPTAB(${st.comptab}): ноль детали пересчитан под поворот стола`); }
      else if (c.name === 'ANGLES') msg(line, 'ANGLES — восстановление углов, пропускаю');
      else if (c.name === 'MSG') msg(line, 'Сообщение: ' + (c.args[0] ?? ''));
      else if (KNOWN_CYCLES.test(c.name)) msg(line, `${c.name} — цикл пока не рисуется (следующий шаг)`, 'warn');
      else if (c.name === 'LATHEON') { /* уже сказали */ }
      else msg(line, `${c.name}(…) — не знаю, пропускаю`, 'warn');
    }
    if (b.kw.has('MCALL') && !b.calls.length) { /* конец модального цикла */ }

    // Стол C
    if (b.words.C !== undefined) {
      const c1 = st.abs ? b.words.C : st.C + b.words.C;
      steps.push({ line, kind: 'table', c0: st.C, c1 });
      st.C = c1;
    }

    // Программируемые кадры
    const ax = b.axes, hasAx = Object.keys(ax).length > 0;
    const vec = () => [ax.X || 0, ax.Y || 0, ax.Z || 0];
    if (b.kw.has('TRANS')) { st.T = vec(); if (!hasAx) st.comptab = 0; return; }
    if (b.kw.has('ATRANS')) { st.T = add(st.T, vec()); return; }
    if (b.kw.has('ROT') || b.kw.has('AROT')) {
      let R = b.kw.has('ROT') ? I3 : st.Rp;
      for (const k of ['X', 'Y', 'Z']) if (ax[k] !== undefined) R = K.matMul(R, ROTS[AX[k] + 1](ax[k]));
      if (b.words.RPL !== undefined) R = K.matMul(R, K.rotZ(b.words.RPL));
      st.Rp = R; return;
    }

    // SUPA — координаты станка. Нулей станка не знаем → показываем как отвод вверх.
    if (b.kw.has('SUPA')) {
      const M1 = [st.M[0], st.M[1], opts.parkZ ?? st.M[2] + 500];
      const t0 = tip(), M0 = st.M;
      st.M = M1; const t1 = tip(); st.M = M0;
      move(line, 'rapid', [t0, t1]);
      msg(line, 'SUPA — координаты станка: показываю как отвод вверх');
      return;
    }

    if (!hasAx) return;
    const p0 = progNow();
    const p1 = [...p0];
    for (const k of ['X', 'Y', 'Z']) if (ax[k] !== undefined) p1[AX[k]] = st.abs ? ax[k] : p0[AX[k]] + ax[k];
    if (st.motion === 2 || st.motion === 3) {
      const pts = arcPoints(line, p0, p1, b, st.motion === 2).map(toWorld);
      move(line, 'feed', pts);
    } else {
      move(line, st.motion === 0 ? 'rapid' : 'feed', [toWorld(p0), toWorld(p1)]);
    }
  });

  return { steps, msgs, rapid, feed, end: { a: st.a, b: st.b, M: st.M, C: st.C } };
}

// Примеры из мануала FPT (стр. 22–24)
export const SAMPLES = {
  sides: `; Мануал FPT, стр. 22-23: обработка с четырёх сторон (TUPC + CYCLE800)
N000 G40 G642 G90 G71 D0
N100 G17G54
N102 ;=====FRONT SIDE=======================
N200 CYCLE800()
N250 LATHEOF
N300 SUPA G0Y-200Z1500D0
N400 M_20(0,0)
N500 T="FR100"
N600 M6D1
N700 SUPA G0Y-200Z1500D0
N702 D1
N704 CYCLE800(0,"TUPC",100000,57,0,0,0,0,0,0,0,0,0,-1,100,1)
N800 G0X-310Y160Z400
N900 S450M3
N1000 G0Z220 M8
N1100 G1Z210F1800
N1200 Y-100
N1300 X-220
N1400 Y160
N1500 G0Z250
N1600 G0X220Y-160
N1700 G0Z220
N1800 G1Z210
N1900 Y100
N2000 X310
N2100 Y-160
N2200 G0Z400
N2300 M9
N2400 M5
N2500 CYCLE800()
N2600 SUPA G0Y-200Z1500D0
;=====LEFT SIDE ========================
N2700 D1
N2800 CYCLE800(0,"TUPC",100000,57,0,0,0,0,-90,0,0,0,0,-1,100,1)
N2900 G0Z500
N3000 G0X-280Y0Z435
N3100 S450M3
N3200 G1G41X-150F1000 M8
N3300 G2X-150Y0I150J0
N3400 G1G40X-280Y0
N3500 Z430
N3600 G1G41X-150F1000
N3700 G2X-150Y0I150J0
N3800 G1G40X-280Y0
N3900 G0Z450
N4000 M9
N4100 M5
N4200 CYCLE800()
N4300 SUPA G0Y-200Z1500D0
;=====RIGHT SIDE ========================
N4400 D1
N4500 CYCLE800(0,"TUPC",100000,57,0,0,0,0,90,0,0,0,0,-1,100,1)
N4600 G0Z500
N4700 G0X280Y0Z435
N4800 S450M3
N4900 G1G41X150F1000 M8
N5000 G2X150Y0I-150J0
N5100 G1G40X280Y0
N5200 Z430
N5300 G1G41X150F1000
N5400 G2X150Y0I-150J0
N5500 G1G40X280Y0
N5600 G0Z450
N5700 M9M5
N5800 CYCLE800()
N5900 SUPA G0Y-200Z1500D0
;=====TOP SIDE==========================
N6000 D1
N6100 CYCLE800(0,"TUPC",100000,57,0,0,0,-90,0,0,0,0,0,-1,100,1)
N6200 G0Z350
N6300 G0X0Y-250Z250
N6400 S450M3
N6500 G1X0Y-160F1000 M8
N6600 G2X0Y-160I0J160
N6700 G1X0Y-250
N6800 Z260
N6900 G0X0Y0
N7000 POCKET4(300,250,2,80,160,0,0,5,0,0,1000,2000,0,2,300,300,0,,)
N7100 G0Z300
N7200 M9M5
N7300 CYCLE800()
N7400 SUPA G0Y-200Z1500D0
N7500 M_20(0,0)
N7600 M30
`,
  comptab: `; Мануал FPT, стр. 24: стол повёрнут, COMPTAB + CYCLE800 под 45°
N0 G40 G642 G90 G71 D0
N1 G54 G17
N2 CYCLE800()
N3 LATHEOF
N4 SUPA G0Y-200Z1500D0
N5 M_20(0,0)
N6 T9
N7 M6D1
N8 C-90
N10 COMPTAB(-90)
N11 D1
N12 CYCLE800(0,"TUPC",100001,57,0,0,0,-45,0,0,0,0,0,-1,100,1)
N13 G0 X0.0 Y-330 Z350
N14 S1000M3
N13 Z256
N14 G1 Z253 F5000
N15 Y-290
N16 X-250
N17 G2 X-290 Y-250 I0.0 J40
N18 G1 Y250
N19 G2 X-250 Y290 I40 J0.0
N20 G1 X250
N21 G2 X290 Y250 I0.0 J-40
N22 G1 Y-250
N23 G2 X250 Y-290 I-40 J0.0
N24 G1 X0.0
N25 Y-330
N26 Z256
N27 G0 Z350 M5
N28 CYCLE800()
N29 TRANS
N30 SUPA G0 Y-215 Z-1574 D0
N31 M30
`,
};
