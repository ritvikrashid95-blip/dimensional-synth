// ─── RIPPLE TANK — Application State, Pointer Interaction, HUD, Animation Loop
import './style.css';
import { WaveSolver } from './physics.js';
import { HydrophoneEngine } from './audio.js';
import { WaveRenderer } from './render.js';

// ─── State ─────────────────────────────────────────────────────────
const solver   = new WaveSolver();
const audio    = new HydrophoneEngine();
const canvas   = /** @type {HTMLCanvasElement} */ (document.getElementById('stage'));
const renderer = new WaveRenderer(canvas);
const hud      = /** @type {HTMLDivElement} */ (document.getElementById('hud'));
const overlay  = /** @type {HTMLDivElement} */ (document.getElementById('overlay'));

const N = solver.N;

let tool = 'ripple'; // ripple | moveHydro | drawWall | eraseWall | autoDrip
let running = false;
let pointerDown = false;
let lastGridX = -1, lastGridY = -1;
let draggingProbe = -1;
let holdTimer = null;
let holdPulsing = false;

// Auto-dripper state (up to 3)
const drippers = []; // { gridX, gridY, phase, interval }
const MAX_DRIPPERS = 3;

// ─── Coordinate helpers ────────────────────────────────────────────
function canvasToGrid(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const gx = ((clientX - rect.left) / rect.width) * N;
  const gy = ((clientY - rect.top) / rect.height) * N;
  return [Math.round(gx), Math.round(gy)];
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// ─── HUD Build ─────────────────────────────────────────────────────
function buildHUD() {
  hud.innerHTML = `
    <div class="hud-row hud-title">
      <span class="hud-logo">◈</span> RIPPLE TANK
      <span class="hud-sub">HYDROPHONE SYNTH</span>
    </div>

    <div class="hud-row">
      <label class="hud-label">TOOL</label>
      <div class="hud-tools" id="tool-btns">
        <button data-tool="ripple" class="active" title="Drop stones / create waves">🌊 Ripple</button>
        <button data-tool="moveHydro" title="Drag hydrophones">🎙 Hydrophone</button>
        <button data-tool="drawWall" title="Draw reflective walls">🧱 Wall</button>
        <button data-tool="eraseWall" title="Erase walls">🗑 Erase</button>
        <button data-tool="autoDrip" title="Place auto-drippers (max 3)">💧 Dripper</button>
      </div>
    </div>

    <div class="hud-row">
      <label class="hud-label">CHAMBER</label>
      <div class="hud-tools" id="preset-btns">
        <button data-preset="clear">Open Water</button>
        <button data-preset="ellipse">Whispering Gallery</button>
        <button data-preset="harbor">Harbor Breakwater</button>
        <button data-preset="cavity">Resonant Cavity</button>
      </div>
    </div>

    <div class="hud-row">
      <label class="hud-label">SCALE</label>
      <select id="scale-sel"></select>
    </div>

    <div class="hud-row">
      <label class="hud-label">WAVE SPEED (c²)</label>
      <input type="range" id="slider-c2" min="0.10" max="0.35" step="0.01" value="0.22">
      <span class="hud-val" id="val-c2">0.22</span>
    </div>

    <div class="hud-row">
      <label class="hud-label">DAMPING</label>
      <input type="range" id="slider-damp" min="0.975" max="0.998" step="0.001" value="0.992">
      <span class="hud-val" id="val-damp">0.992</span>
    </div>

    <div class="hud-row">
      <button id="btn-clear-waves" class="hud-btn-sm">Clear Waves</button>
      <button id="btn-clear-walls" class="hud-btn-sm">Clear Walls</button>
      <button id="btn-clear-drip"  class="hud-btn-sm">Clear Drippers</button>
    </div>

    <div class="hud-row hud-readout">
      <span class="hud-label">ENERGY</span>
      <span id="energy-val" class="energy-bar">▁▁▁▁▁▁▁▁</span>
    </div>
  `;

  // Prevent pointer events on HUD from hitting the canvas
  hud.addEventListener('pointerdown', e => e.stopPropagation());
  hud.addEventListener('pointermove', e => e.stopPropagation());
  hud.addEventListener('pointerup',   e => e.stopPropagation());
  hud.addEventListener('click',       e => e.stopPropagation());

  // Tool buttons
  const toolBtns = hud.querySelectorAll('#tool-btns button');
  toolBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tool = btn.dataset.tool;
      toolBtns.forEach(b => b.classList.toggle('active', b === btn));
    });
  });

  // Preset buttons
  hud.querySelectorAll('#preset-btns button').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = btn.dataset.preset;
      solver.clearWaves();
      if (p === 'clear')   solver.clearWalls();
      if (p === 'ellipse') solver.presetEllipse();
      if (p === 'harbor')  solver.presetHarbor();
      if (p === 'cavity')  solver.presetCavity();
    });
  });

  // Scale selector
  const scaleSel = /** @type {HTMLSelectElement} */ (document.getElementById('scale-sel'));
  for (const name of audio.getScaleNames()) {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    scaleSel.appendChild(opt);
  }
  scaleSel.addEventListener('change', () => audio.setScale(scaleSel.value));

  // Sliders
  const sliderC2   = /** @type {HTMLInputElement} */ (document.getElementById('slider-c2'));
  const sliderDamp = /** @type {HTMLInputElement} */ (document.getElementById('slider-damp'));
  const valC2   = document.getElementById('val-c2');
  const valDamp = document.getElementById('val-damp');

  sliderC2.addEventListener('input', () => {
    solver.c2 = parseFloat(sliderC2.value);
    valC2.textContent = sliderC2.value;
  });
  sliderDamp.addEventListener('input', () => {
    solver.damping = parseFloat(sliderDamp.value);
    valDamp.textContent = sliderDamp.value;
  });

  // Clear buttons
  document.getElementById('btn-clear-waves').addEventListener('click', () => solver.clearWaves());
  document.getElementById('btn-clear-walls').addEventListener('click', () => solver.clearWalls());
  document.getElementById('btn-clear-drip').addEventListener('click', () => { drippers.length = 0; });
}

// ─── Pointer Interaction ───────────────────────────────────────────
function onPointerDown(e) {
  pointerDown = true;
  const [gx, gy] = canvasToGrid(e.clientX, e.clientY);
  lastGridX = gx; lastGridY = gy;

  if (tool === 'ripple') {
    solver.dropStone(gx, gy, 5, 1.8);
    // Start hold-pulse timer
    holdPulsing = false;
    holdTimer = setTimeout(() => {
      holdPulsing = true;
    }, 350);
  } else if (tool === 'moveHydro') {
    // Find nearest probe
    let bestDist = Infinity;
    draggingProbe = -1;
    for (let i = 0; i < audio.probes.length; i++) {
      const p = audio.probes[i];
      const d = Math.hypot(p.gridX - gx, p.gridY - gy);
      if (d < bestDist && d < 15) { bestDist = d; draggingProbe = i; }
    }
  } else if (tool === 'drawWall' || tool === 'eraseWall') {
    // Will draw on move
  } else if (tool === 'autoDrip') {
    if (drippers.length < MAX_DRIPPERS) {
      drippers.push({
        gridX: clamp(gx, 2, N - 2),
        gridY: clamp(gy, 2, N - 2),
        phase: 0,
        interval: 18, // frames between drops
      });
    }
  }
}

function onPointerMove(e) {
  if (!pointerDown) return;
  const [gx, gy] = canvasToGrid(e.clientX, e.clientY);

  if (tool === 'ripple') {
    // Drag creates a wake
    solver.dropStone(gx, gy, 3, 0.8);
  } else if (tool === 'moveHydro' && draggingProbe >= 0) {
    audio.moveProbe(draggingProbe, clamp(gx, 2, N - 2), clamp(gy, 2, N - 2));
  } else if (tool === 'drawWall' || tool === 'eraseWall') {
    if (lastGridX >= 0) {
      solver.setWallLine(lastGridX, lastGridY, gx, gy, tool === 'eraseWall');
    }
    lastGridX = gx; lastGridY = gy;
  }
}

function onPointerUp() {
  pointerDown = false;
  draggingProbe = -1;
  holdPulsing = false;
  if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
}

canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointermove', onPointerMove);
canvas.addEventListener('pointerup',   onPointerUp);
canvas.addEventListener('pointerleave', onPointerUp);
// Prevent context-menu on long press on mobile
canvas.addEventListener('contextmenu', e => e.preventDefault());

// ─── Resize ────────────────────────────────────────────────────────
function onResize() { renderer.resize(); }
window.addEventListener('resize', onResize);
onResize();

// ─── Energy readout ────────────────────────────────────────────────
const ENERGY_BLOCKS = '▁▂▃▄▅▆▇█';
function updateEnergyReadout() {
  let energy = 0;
  for (let i = 0; i < N * N; i++) energy += solver.uCurr[i] * solver.uCurr[i];
  energy = Math.sqrt(energy / (N * N));
  const normed = Math.min(energy / 0.3, 1);
  const barLen = 12;
  let bar = '';
  for (let i = 0; i < barLen; i++) {
    const level = Math.max(0, Math.min(7, Math.floor(normed * 8 * (1 - i / barLen * 0.6))));
    bar += ENERGY_BLOCKS[level];
  }
  const el = document.getElementById('energy-val');
  if (el) el.textContent = bar + ` ${(normed * 100).toFixed(0)}%`;
}

// ─── Animation Loop ────────────────────────────────────────────────
let frameCount = 0;

function loop() {
  if (!running) return;
  requestAnimationFrame(loop);

  // Hold-pulsing source
  if (holdPulsing && pointerDown && tool === 'ripple') {
    if (frameCount % 6 === 0) {
      solver.dropStone(lastGridX, lastGridY, 4, 1.2);
    }
  }

  // Auto-drippers
  for (const d of drippers) {
    d.phase++;
    if (d.phase >= d.interval) {
      d.phase = 0;
      solver.dropStone(d.gridX, d.gridY, 3, 1.0);
    }
  }

  // Physics: run 2 sub-steps per frame for stability
  solver.step();
  solver.step();

  // Render
  renderer.draw(solver.uCurr, solver.walls, N, audio.probes);

  // Audio
  audio.tick(solver.uCurr, N);

  // Readout (throttled)
  if (frameCount % 8 === 0) updateEnergyReadout();
  frameCount++;
}

// ─── Start ─────────────────────────────────────────────────────────
buildHUD();

overlay.addEventListener('click', async () => {
  await audio.init();
  overlay.classList.add('hidden');
  running = true;

  // Drop an initial stone in the centre
  solver.dropStone(Math.round(N / 2), Math.round(N / 2), 6, 2.0);

  loop();
});

overlay.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') overlay.click();
});
