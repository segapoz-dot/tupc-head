// 3D-модель головы TUPC: ползун, 1-й корпус (ось a), 2-й корпус (ось b под 45°), шпиндель, инструмент, стол.
// Система координат как в станке: Z — вверх. Начало координат — торец ползуна (точка M).
// Размеры примерные (по рисункам мануала), меняются через setGeom().
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { K_AXIS, DEFAULT_GEOM } from './kinematics.js';

const DEG = Math.PI / 180;

// Цилиндр с косым срезом.
//  axis 'y': ось вдоль Y, ровный торец на y = flat, косой срез по плоскости y + z = 0 (1-й корпус).
//  axis 'z': ось вдоль Z, ровный торец на z = flat, косой срез по плоскости y + z = 0 (2-й корпус).
function cutCylinder(r, axis, flat, segs = 72) {
  const g = new THREE.CylinderGeometry(r, r, 1, segs, 1, false);
  if (axis === 'z') g.rotateX(Math.PI / 2); // верх цилиндра → +Z
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    if (axis === 'y') p.setY(i, y > 0 ? flat : -z);
    else p.setZ(i, z > 0 ? -y : flat);
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

function cyl(r1, r2, h, segs = 48) { return new THREE.CylinderGeometry(r1, r2, h, segs); }

// Надпись-спрайт (X, Y, Z)
function label(text, color, size = 110) {
  const c = document.createElement('canvas'); c.width = 128; c.height = 128;
  const ctx = c.getContext('2d');
  ctx.font = 'bold 84px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 10; ctx.strokeStyle = 'rgba(0,0,0,.75)'; ctx.strokeText(text, 64, 68);
  ctx.fillStyle = color; ctx.fillText(text, 64, 68);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(size, size, 1); s.renderOrder = 10;
  return s;
}

function dashedLine(from, to, color) {
  const g = new THREE.BufferGeometry().setFromPoints([from, to]);
  const l = new THREE.Line(g, new THREE.LineDashedMaterial({ color, dashSize: 30, gapSize: 18, depthTest: false, transparent: true, opacity: 0.85 }));
  l.computeLineDistances(); l.renderOrder = 5;
  return l;
}

export class HeadView {
  constructor(container) {
    this.container = container;
    this.geom = { ...DEFAULT_GEOM };
    this.cur = { a: 0, b: 0 };     // что сейчас нарисовано
    this.target = { a: 0, b: 0 };  // куда едем
    this.speed = 120;              // град/с при плавном повороте
    this.onFrame = null;           // колбэк (a, b) на каждом кадре движения

    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(r.domElement);

    const scene = this.scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1b1e22);

    const cam = this.camera = new THREE.PerspectiveCamera(35, 1, 10, 30000);
    cam.up.set(0, 0, 1);
    const ctl = this.controls = new OrbitControls(cam, r.domElement);
    ctl.enableDamping = true; ctl.dampingFactor = 0.12;
    ctl.rotateSpeed = 0.8;

    scene.add(new THREE.HemisphereLight(0xdfe8f0, 0x2a2622, 1.1));
    const d1 = new THREE.DirectionalLight(0xffffff, 1.6); d1.position.set(1500, -2500, 3000); scene.add(d1);
    const d2 = new THREE.DirectionalLight(0xffd9b0, 0.6); d2.position.set(-2500, 1500, 800); scene.add(d2);

    this.mat = {
      ram: new THREE.MeshStandardMaterial({ color: 0x8c949c, metalness: 0.35, roughness: 0.55 }),
      body1: new THREE.MeshStandardMaterial({ color: 0xb9bfc6, metalness: 0.4, roughness: 0.45 }),
      body2: new THREE.MeshStandardMaterial({ color: 0xd2d6db, metalness: 0.4, roughness: 0.4 }),
      ring: new THREE.MeshStandardMaterial({ color: 0x60666e, metalness: 0.5, roughness: 0.4 }),
      fin: new THREE.MeshStandardMaterial({ color: 0x9aa1a8, metalness: 0.5, roughness: 0.35 }),
      yellow: new THREE.MeshStandardMaterial({ color: 0xf2c200, metalness: 0.2, roughness: 0.5 }),
      tool: new THREE.MeshStandardMaterial({ color: 0xff7a1a, metalness: 0.3, roughness: 0.35, emissive: 0x3a1500 }),
      holder: new THREE.MeshStandardMaterial({ color: 0x3d4248, metalness: 0.6, roughness: 0.35 }),
      table: new THREE.MeshStandardMaterial({ color: 0x5a6068, metalness: 0.3, roughness: 0.6 }),
      part: new THREE.MeshStandardMaterial({ color: 0x4f7fa8, metalness: 0.2, roughness: 0.6, transparent: true, opacity: 0.85 }),
    };

    this.root = new THREE.Group(); scene.add(this.root);
    this.build();

    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(container);
    this.resize();
    this.setView('3d');
    this.clock = new THREE.Clock();
    r.setAnimationLoop(() => this.tick());
  }

  // Собрать (или пересобрать) модель под текущие размеры
  build() {
    const { d1, h, d2, L } = this.geom;
    const m = this.mat;
    this.root.clear();

    // --- ползун (неподвижный): квадрат 420×420, уходит от торца M в сторону +Y
    const ram = new THREE.Mesh(new THREE.BoxGeometry(420, 1600, 420), m.ram);
    ram.position.set(0, 800, 0); this.root.add(ram);
    const flange = new THREE.Mesh(cyl(270, 270, 40), m.ring); // фланец на торце (ось цилиндра — Y)
    flange.position.set(0, -20, 0); this.root.add(flange);

    // --- точка P (пересечение осей a и b) — сюда вешаем оба корпуса
    const P = this.pivot = new THREE.Vector3(0, -d1, 0);

    // 1-й корпус: крутится вокруг Y (ось a). Цилиндр от фланца до косого среза под 45°.
    const b1 = this.body1 = new THREE.Group(); b1.position.copy(P); this.root.add(b1);
    const r1 = 225;
    b1.add(new THREE.Mesh(cutCylinder(r1, 'y', Math.max(d1 - 40, r1 + 15)), m.body1));
    // Кольцо-стык на косой плоскости
    const ring = new THREE.Mesh(cyl(r1 * 1.42 + 12, r1 * 1.42 + 12, 14, 72), m.ring);
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...K_AXIS));
    ring.position.set(0, 4, 4); b1.add(ring);
    // Метка на 1-м корпусе (видно, как он повернулся)
    const mark1 = new THREE.Mesh(new THREE.BoxGeometry(60, 90, 30), m.yellow);
    mark1.position.set(0, Math.max(d1 - 120, 40), r1 + 8); b1.add(mark1);
    // Ось a (пунктир вдоль Y)
    this.root.add(dashedLine(new THREE.Vector3(0, 900, 0), new THREE.Vector3(0, -d1 - 800, 0), 0x52c7ff));
    const la = label('a', '#52c7ff', 90); la.position.set(0, -d1 - 860, 0); this.root.add(la);

    // 2-й корпус: крутится вокруг наклонной оси k (ось b), внутри 1-го корпуса
    const b2 = this.body2 = new THREE.Group(); b1.add(b2);
    const kv = new THREE.Vector3(...K_AXIS), kOut = kv.clone().negate(); // kOut = (0,−1,−1)/√2 — от стыка вниз-наружу
    // Ось b (пунктир) — в 1-м корпусе, чтобы крутилась вместе с a
    b1.add(dashedLine(kv.clone().multiplyScalar(450), kOut.clone().multiplyScalar(h * Math.SQRT2 + 450), 0xff5ad1));
    const lb = label('b', '#ff5ad1', 90); lb.position.copy(kOut.clone().multiplyScalar(h * Math.SQRT2 + 520)); b1.add(lb);
    // Наклонный фланец 2-го корпуса (толстый диск на стыке)
    const slant = new THREE.Mesh(cyl(205, 205, 100, 72), m.body2);
    slant.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), kOut);
    slant.position.copy(kOut.clone().multiplyScalar(58)); b2.add(slant);

    // Корпус шпинделя с рёбрами — вертикально через точку S = (0, −h, −h), она на оси b (рисунок стр. 6)
    const zNose = -h - d2, zTop = -h + 330;
    const put = (mesh, z) => { mesh.rotation.x = Math.PI / 2; mesh.position.set(0, -h, z); b2.add(mesh); return mesh; };
    const coreH = zTop - (zNose + 20);
    put(new THREE.Mesh(cyl(115, 115, coreH), m.body2), zNose + 20 + coreH / 2);
    for (let z = zNose + 40; z < zTop - 40; z += 20) put(new THREE.Mesh(cyl(140, 140, 8), m.fin), z);
    put(new THREE.Mesh(cyl(40, 115, 90), m.ring), zTop + 45);   // крышка сверху
    put(new THREE.Mesh(cyl(75, 75, 20), m.ring), zNose + 10);   // торец шпинделя
    // Жёлтая метка сбоку на корпусе шпинделя — видно разворот вокруг своей оси
    const mark2 = new THREE.Mesh(new THREE.BoxGeometry(40, 70, 110), m.yellow);
    mark2.position.set(150, -h, zTop - 90); b2.add(mark2);
    // Точка S (где ось шпинделя пересекает ось b)
    const sv = new THREE.Mesh(new THREE.SphereGeometry(13, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff5ad1, depthTest: false }));
    sv.renderOrder = 7; sv.position.set(0, -h, -h); b2.add(sv);

    // Инструмент: оправка + фреза, вершина на L ниже торца шпинделя
    const tool = this.tool = new THREE.Group(); b2.add(tool);
    const hHold = Math.min(70, L * 0.45);
    put(new THREE.Mesh(cyl(55, 34, hHold), m.holder), zNose - hHold / 2);
    const hCut = Math.max(5, L - hHold);
    put(new THREE.Mesh(cyl(18, 18, hCut, 24), m.tool), zNose - hHold - hCut / 2);
    // Стрелка «куда смотрит инструмент»
    const tipZ = zNose - L;
    this.arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, -h, tipZ), 260, 0xff3b30, 70, 40);
    this.arrow.line.material.depthTest = false; this.arrow.cone.material.depthTest = false;
    this.arrow.renderOrder = 6; b2.add(this.arrow);
    const tip = this.tipMesh = new THREE.Mesh(new THREE.SphereGeometry(14, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    tip.position.set(0, -h, tipZ); b2.add(tip);
    // Точка P
    const pv = new THREE.Mesh(new THREE.SphereGeometry(16, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
    pv.renderOrder = 7; b1.add(pv);

    // --- поворотный стол C и деталь (для ориентира)
    const tableTop = this.tableTop = -(h + d2 + L) - 420;
    const tg = this.table = new THREE.Group(); tg.position.set(0, -d1 - h, tableTop); this.root.add(tg);
    const disk = new THREE.Mesh(cyl(650, 650, 90, 96), m.table);
    disk.rotation.x = Math.PI / 2; disk.position.z = -45; tg.add(disk);
    for (const ang of [0, 45, 90, 135]) { // пазы
      const slot = new THREE.Mesh(new THREE.BoxGeometry(1240, 22, 4), new THREE.MeshStandardMaterial({ color: 0x2b2f34 }));
      slot.rotation.z = ang * DEG; slot.position.z = 1; tg.add(slot);
    }
    const c0 = new THREE.Mesh(new THREE.BoxGeometry(40, 160, 6), m.yellow); // метка C0
    c0.position.set(0, -560, 3); tg.add(c0);
    const part = new THREE.Mesh(new THREE.BoxGeometry(360, 360, 220), m.part);
    part.position.z = 110; tg.add(part);
    const base = new THREE.Mesh(new THREE.BoxGeometry(1700, 1500, 300), m.ram);
    base.position.set(0, -d1 - h, tableTop - 90 - 150); this.root.add(base);

    // Сетка пола и оси станка
    const grid = new THREE.GridHelper(6000, 30, 0x3a4048, 0x2a2f35);
    grid.rotation.x = Math.PI / 2; grid.position.set(0, -d1 - h, tableTop - 400); this.root.add(grid);
    const O = new THREE.Vector3(-1150, -d1 - h - 900, tableTop - 395);
    const axes = [[[1, 0, 0], 0xff4d4d, 'X', '#ff6b6b'], [[0, 1, 0], 0x4dff7a, 'Y', '#5dff8a'], [[0, 0, 1], 0x4d9dff, 'Z', '#6aaeff']];
    for (const [v, c, t, cs] of axes) {
      const dir = new THREE.Vector3(...v);
      this.root.add(new THREE.ArrowHelper(dir, O, 450, c, 80, 45));
      const l = label(t, cs); l.position.copy(O.clone().add(dir.multiplyScalar(560))); this.root.add(l);
    }

    this.setTableC(this.tableC || 0);
    this.applyAngles(this.cur.a, this.cur.b);
    this.focus = new THREE.Vector3(0, -d1 - h * 0.5, -(h + d2 + L) * 0.6);
  }

  setGeom(g) { this.geom = { ...this.geom, ...g }; this.build(); }
  setTableC(c) { this.tableC = c; if (this.table) this.table.rotation.z = c * DEG; }

  applyAngles(a, b) {
    this.body1.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), a * DEG);
    this.body2.quaternion.setFromAxisAngle(new THREE.Vector3(...K_AXIS), b * DEG);
  }

  // Поставить голову. animate=true — плавно (как едут корпуса), иначе сразу.
  setAngles(a, b, animate = true) {
    this.target = { a, b };
    if (!animate) { this.cur = { a, b }; this.applyAngles(a, b); this.onFrame && this.onFrame(a, b, true); }
  }

  tick() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const { cur, target } = this;
    if (cur.a !== target.a || cur.b !== target.b) {
      const da = target.a - cur.a, db = target.b - cur.b;
      const T = Math.max(Math.abs(da), Math.abs(db)) / this.speed; // оба корпуса приходят одновременно
      if (T <= dt) { cur.a = target.a; cur.b = target.b; }
      else { cur.a += da * dt / T; cur.b += db * dt / T; }
      this.applyAngles(cur.a, cur.b);
      this.onFrame && this.onFrame(cur.a, cur.b, cur.a === target.a && cur.b === target.b);
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  setView(name) {
    const f = this.focus || new THREE.Vector3(0, -330, -300);
    const D = 3600;
    const pos = {
      '3d': new THREE.Vector3(1700, -2700, 1100),
      front: new THREE.Vector3(0, -D, 0),     // смотрим с Y− на ползун
      side: new THREE.Vector3(D, 0, 0),       // справа, с X+
      top: new THREE.Vector3(0, -1, D),       // сверху
    }[name] || new THREE.Vector3(1700, -2700, 1100);
    this.camera.position.copy(f).add(pos);
    this.controls.target.copy(f);
    this.controls.update();
  }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%'; this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }
}
