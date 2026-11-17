// Кинематика головы TUPC (FPT TESSEN-TURN, Sinumerik 840D).
// Только математика — без 3D и интерфейса. Формулы и проверка — docs/КИНЕМАТИКА.md.
//
// Система координат (как в программе станка, G17):
//   Z — вверх, X — вдоль станины, Y — вдоль ползуна (ram). Голова висит на конце ползуна в сторону Y−.
//   «Вектор инструмента» t — куда смотрит ВЕРШИНА инструмента (единичный вектор).
//   a — 1-й корпус, крутится вокруг оси ползуна (+Y), 0…360°.
//   b — 2-й корпус, крутится вокруг наклонной оси под 45°, направление k = (0, 1, 1)/√2 (при a = 0), −180…+180°.
//   При a = 0, b = 0 инструмент смотрит вниз: t = (0, 0, −1).
//
//   t(a, b) = Ry(a) · Rk(b) · (0, 0, −1)

export const DEG = Math.PI / 180;
const S2 = Math.SQRT1_2;
export const K_AXIS = [0, S2, S2]; // ось 2-го корпуса при a = 0
export const A_AXIS = [0, 1, 0];   // ось 1-го корпуса
const EPS = 1e-9;

// ---------- мелкие помощники ----------
export const norm360 = (x) => { let v = x % 360; if (v < 0) v += 360; return Math.abs(v - 360) < 1e-9 ? 0 : v; };
export const norm180 = (x) => { let v = norm360(x); if (v > 180) v -= 360; return v; };
export const round3 = (x) => { const r = Math.round(x * 1000) / 1000; return Object.is(r, -0) ? 0 : r; };
export const len = (v) => Math.hypot(v[0], v[1], v[2]);
export const unit = (v) => { const l = len(v); return l < EPS ? null : [v[0] / l, v[1] / l, v[2] / l]; };
export const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
export const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];

// Матрицы 3×3 храним как массив строк.
export const matVec = (m, v) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
export const matMul = (m, n) => m.map((r) => [0, 1, 2].map((j) => r[0] * n[0][j] + r[1] * n[1][j] + r[2] * n[2][j]));

export const rotX = (deg) => { const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG); return [[1, 0, 0], [0, c, -s], [0, s, c]]; };
export const rotY = (deg) => { const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG); return [[c, 0, s], [0, 1, 0], [-s, 0, c]]; };
export const rotZ = (deg) => { const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; };
// Поворот вокруг произвольной единичной оси k (формула Родрига)
export function rotAxis(k, deg) {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG), C = 1 - c;
  const [x, y, z] = k;
  return [
    [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
  ];
}

// ---------- прямая задача: углы → вектор ----------
// Поворот 1-го корпуса и всей головы целиком (для 3D-модели)
export const body1Matrix = (a) => rotY(a);
export const body2Matrix = (a, b) => matMul(rotY(a), rotAxis(K_AXIS, b));

// Вектор инструмента по углам a, b
export function toolDir(a, b) {
  return matVec(body2Matrix(a, b), [0, 0, -1]);
}

// ---------- обратная задача: вектор → углы ----------
// Возвращает { ok, solutions:[{a,b}], free, reason, nearest }
//   ok=false — голова так встать не может (t смотрит в Y+), nearest — ближайший достижимый вектор.
//   free=true — b = 180°, инструмент смотрит в Y−, угол a любой (особая точка).
export function solveAB(tIn) {
  const t = unit(tIn);
  if (!t) return { ok: false, solutions: [], reason: 'Нулевой вектор' };
  const [tx, ty, tz] = t;

  if (ty > 1e-7) {
    const n = unit([tx, 0, tz]) || [0, 0, -1];
    return {
      ok: false, solutions: [], nearest: n,
      reason: 'Голова не может смотреть в сторону Y+ (в ползун). Достижимо только Y ≤ 0.',
    };
  }

  // Ry(a) не меняет Y, а у Rk(b)·(0,0,−1) Y = −(1 − cos b)/2  ⇒  cos b = 1 + 2·ty
  const cb = Math.max(-1, Math.min(1, 1 + 2 * ty));
  const b0 = Math.acos(cb) / DEG; // 0…180

  if (b0 > 180 - 1e-6) {
    return { ok: true, free: true, solutions: [{ a: 0, b: 180 }], reason: 'b = 180°: инструмент смотрит в Y−, угол a любой (берём 0).' };
  }

  const sols = [];
  for (const b of (b0 < 1e-6 ? [0] : [b0, -b0])) {
    // v = Rk(b)·(0,0,−1); a — разница углов в плоскости XZ (угол φ = atan2(x, z))
    const v = matVec(rotAxis(K_AXIS, b), [0, 0, -1]);
    const a = Math.atan2(tx, tz) / DEG - Math.atan2(v[0], v[2]) / DEG;
    sols.push({ a: norm360(a), b: norm180(b) });
  }
  return { ok: true, free: false, solutions: sols };
}

// ---------- CYCLE800 «ось за осью» (режим 57): поворот вокруг X, потом Y, потом Z ----------
// Повороты последовательные (каждый — вокруг уже повёрнутой оси): R = Rx(A)·Ry(B)·Rz(C).
// Инструмент смотрит против новой оси Z: t = −R·(0,0,1).
export function frameMatrix(A, B, C) {
  return matMul(matMul(rotX(A), rotY(B)), rotZ(C));
}
export function frameToDir(A, B, C = 0) {
  const z = matVec(frameMatrix(A, B, C), [0, 0, 1]);
  return [-z[0], -z[1], -z[2]];
}
// Вектор → углы «ось за осью» (C = 0)
export function dirToFrame(tIn) {
  const t = unit(tIn);
  const B = Math.asin(Math.max(-1, Math.min(1, -t[0]))) / DEG;
  const A = Math.abs(Math.cos(B * DEG)) < 1e-9 ? 0 : Math.atan2(t[1], -t[2]) / DEG;
  return { A, B, C: 0 };
}

// ---------- геометрия головы: точки ----------
// По рисункам мануала (стр. 6): оси a и b пересекаются в точке P, а ось шпинделя через P НЕ проходит —
// она пересекает ось b ниже, в точке S (при b = 180° шпиндель горизонтален, но ниже оси ползуна).
// geom: { d1 — от торца ползуна (опорная точка M) до P, по оси Y;
//         h  — смещение оси шпинделя: S = P + (0, −h, −h) при a = b = 0 (S лежит на оси b);
//         d2 — от S до торца шпинделя вдоль оси шпинделя;
//         L  — вылет инструмента от торца шпинделя }
// Числа по умолчанию сняты с пропорций рисунка (радиус 1-го корпуса принят 225 мм) — уточнить на станке.
export const DEFAULT_GEOM = { d1: 300, h: 225, d2: 30, L: 150 };

export function pivotFromRef(M, geom) { return [M[0], M[1] - geom.d1, M[2]]; }
// Точка на оси шпинделя на расстоянии s ниже S (в системе головы при a = b = 0) → в координаты станка
function headPoint(M, a, b, geom, s) {
  const P = pivotFromRef(M, geom);
  const q = matVec(body2Matrix(a, b), [0, -geom.h, -geom.h - s]);
  return [P[0] + q[0], P[1] + q[1], P[2] + q[2]];
}
export const crossFromRef = (M, a, b, geom) => headPoint(M, a, b, geom, 0);             // точка S
export const noseFromRef = (M, a, b, geom) => headPoint(M, a, b, geom, geom.d2);        // торец шпинделя
export const tipFromRef = (M, a, b, geom) => headPoint(M, a, b, geom, geom.d2 + geom.L); // вершина
export function refFromTip(tip, a, b, geom) {
  const t0 = tipFromRef([0, 0, 0], a, b, geom);
  return [tip[0] - t0[0], tip[1] - t0[1], tip[2] - t0[2]];
}

// ---------- строки для программы ----------
const f = (x) => String(round3(x));
export const m20Line = (a, b) => `M_20(${f(a)},${f(b)})`;
export const cycle800Direct = (a, b) => `CYCLE800(0,"TUPC",100000,192,0,0,0,${f(a)},${f(b)},0,0,0,0,-1,100,1)`;
export const cycle800Axis = (A, B, C = 0) => `CYCLE800(0,"TUPC",100000,57,0,0,0,${f(A)},${f(B)},${f(C)},0,0,0,-1,100,1)`;

// Словесное описание направления (для подсказки)
export function describeDir(t) {
  const names = [[[1, 0, 0], 'X+'], [[-1, 0, 0], 'X−'], [[0, 1, 0], 'Y+'], [[0, -1, 0], 'Y−'], [[0, 0, 1], 'Z+ (вверх)'], [[0, 0, -1], 'Z− (вниз)']];
  for (const [v, n] of names) if (dot(v, t) > 0.99999) return `ровно в ${n}`;
  const parts = [];
  const ax = ['X', 'Y', 'Z'];
  for (let i = 0; i < 3; i++) if (Math.abs(t[i]) > 1e-4) parts.push(`${ax[i]}${t[i] > 0 ? '+' : '−'}`);
  const tilt = Math.acos(Math.max(-1, Math.min(1, -t[2]))) / DEG;
  return `в сторону ${parts.join(' ')}, наклон от вертикали вниз ${round3(tilt)}°`;
}
