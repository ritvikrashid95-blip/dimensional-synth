import './style.css';
import * as Tone from 'tone';

/* ==========================================================================
   N-Dimensional Synth
   A polyrhythmic / polyphonic audiovisual instrument: N-dimensional polytopes
   (N = 1..6) rotated and perspective-projected onto a canvas, driven by a
   single sample-accurate measure loop in Tone.js.
   ========================================================================== */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_DIM = 6;
const CAMERA_D = 3.5; // camera distance for every perspective step
const PERSPECTIVE_CLAMP = CAMERA_D - 0.4; // x_k never exceeds this → no div-by-zero / inversion

/**
 * Rotation planes. Each plane only participates when both of its axes exist
 * in the current dimension. `drift` is autonomous angular velocity (rad/s);
 * `yaw`/`pitch` are how strongly horizontal / vertical drag couple into it.
 */
const PLANES = [
  { name: 'XY', i: 0, j: 1, drift: 0.04, yaw: 0, pitch: 0 },
  { name: 'XZ', i: 0, j: 2, drift: 0.13, yaw: 1, pitch: 0 },
  { name: 'YZ', i: 1, j: 2, drift: 0.09, yaw: 0, pitch: 1 },
  { name: 'XW', i: 0, j: 3, drift: 0.17, yaw: 0.7, pitch: 0 },
  { name: 'YW', i: 1, j: 3, drift: 0.11, yaw: 0, pitch: 0.7 },
  { name: 'ZW', i: 2, j: 3, drift: 0.07, yaw: 0.3, pitch: 0.3 },
  { name: 'XV', i: 0, j: 4, drift: 0.12, yaw: 0.5, pitch: 0 },
  { name: 'YV', i: 1, j: 4, drift: 0.08, yaw: 0, pitch: 0.5 },
  { name: 'XU', i: 0, j: 5, drift: 0.1, yaw: 0.4, pitch: 0 },
  { name: 'YU', i: 1, j: 5, drift: 0.06, yaw: 0, pitch: 0.4 },
];

/**
 * Rhythmic streams. Each dimensional layer contributes integer pulses per
 * measure. Layer 2 introduces the 3:2 pair; each later layer adds one more.
 * `pattern` holds chord-tone offsets in 7-note scale degrees
 * (0 = root, 2 = 3rd, 4 = 5th, 6 = 7th, 8 = 9th, 10 = 11th, 12 = 13th).
 */
const STREAMS = [
  { layer: 1, R: 1, pattern: [0] },
  { layer: 2, R: 2, pattern: [0, 4] },
  { layer: 2, R: 3, pattern: [2, 4, 6] },
  { layer: 3, R: 4, pattern: [0, 2, 4, 6] },
  { layer: 4, R: 5, pattern: [8, 9, 6, 8, 11] },
  { layer: 5, R: 6, pattern: [10, 8, 11, 7, 10, 9] },
  { layer: 6, R: 7, pattern: [12, 10, 13, 9, 14, 11, 12] },
];

// Base MIDI note per layer: C2 bass, C3 mid, then C4 so 9th/11th/13th land in C5–C6.
const LAYER_BASE_MIDI = [36, 48, 60, 60, 60, 60];
const LAYER_VELOCITY = [0.9, 0.7, 0.6, 0.55, 0.5, 0.45];
const LAYER_HUE = [220, 185, 145, 48, 14, 300];

// Chord-root progression in scale degrees (i – vi – iv – v), voiced near the base.
const PROGRESSION = [0, -2, 3, -3];

const SCALES = {
  dorian: { label: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  lydian: { label: 'Lydian', steps: [0, 2, 4, 6, 7, 9, 11] },
  pentatonic: { label: 'Pentatonic', steps: [0, 3, 5, 7, 10] },
  insen: { label: 'In-Sen', steps: [0, 1, 5, 7, 10] },
};

const FAMILIES = {
  hypercube: {
    label: 'Hypercube',
    hue: 195,
    names: ['Segment', 'Square', 'Cube', 'Tesseract', 'Penteract', 'Hexeract'],
  },
  simplex: {
    label: 'Simplex',
    hue: 265,
    names: ['Segment', 'Triangle', 'Tetrahedron', '5-Cell', '5-Simplex', '6-Simplex'],
  },
  orthoplex: {
    label: 'Orthoplex',
    hue: 320,
    names: ['Segment', 'Diamond', 'Octahedron', '16-Cell', '5-Orthoplex', '6-Orthoplex'],
  },
};

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

const state = {
  dim: 4,
  family: 'hypercube',
  scale: 'dorian',
  bpm: 92,
  playing: false,
};

const rot = { yaw: 0, pitch: 0, yawVel: 0, pitchVel: 0 };
const driftAngles = new Float64Array(PLANES.length);
let dragEnergy = 0; // 0..1, rises with drag speed and decays

// Visual pulse state (written by Tone.Draw callbacks, decayed per frame)
const axisGlow = new Float32Array(MAX_DIM);
const streamTicks = STREAMS.map((s) => new Float32Array(s.R));
let lockFlash = 0;

const activeStreams = (N) => STREAMS.filter((s) => s.layer <= N);

function ratioLabel(N) {
  const rs = activeStreams(N)
    .map((s) => s.R)
    .filter((r) => r > 1)
    .sort((a, b) => b - a);
  return rs.length ? rs.join(':') : '1:1';
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------------------
// Geometry: exact vertex / edge sets for each polytope family
// ---------------------------------------------------------------------------

/**
 * Returns { N, V, base: Float64Array(V*N), edges: Int16Array(E*3) [a,b,axis],
 * E, sets } where sets[layer][parity] lists the vertices lit by that layer.
 */
function buildGeometry(family, N) {
  const verts = [];
  const edges = [];
  const sets = [null];

  if (family === 'hypercube') {
    // 2^N vertices at (±1, …, ±1) / √N → circumradius exactly 1.
    const s = 1 / Math.sqrt(N);
    for (let m = 0; m < 1 << N; m++) {
      const v = [];
      for (let k = 0; k < N; k++) v.push(((m >> k) & 1 ? 1 : -1) * s);
      verts.push(v);
    }
    // Edges join vertices differing in exactly one bit; record that axis.
    for (let a = 0; a < verts.length; a++) {
      for (let k = 0; k < N; k++) {
        const b = a ^ (1 << k);
        if (b > a) edges.push([a, b, k]);
      }
    }
    // Layer L lights the half-cell on either side of axis L-1.
    for (let L = 1; L <= N; L++) {
      const bit = 1 << (L - 1);
      const hi = [];
      const lo = [];
      verts.forEach((_, idx) => (idx & bit ? hi : lo).push(idx));
      sets.push([hi, lo]);
    }
  } else if (family === 'simplex') {
    // N+1 mutually equidistant points: the N basis vectors plus a·(1,…,1),
    // a = (1 − √(N+1)) / N, which sits at distance √2 from each basis vector.
    const a = (1 - Math.sqrt(N + 1)) / N;
    for (let i = 0; i < N; i++) {
      const v = new Array(N).fill(0);
      v[i] = 1;
      verts.push(v);
    }
    verts.push(new Array(N).fill(a));
    // Centre on the centroid and normalise to unit circumradius.
    const c = new Array(N).fill(0);
    verts.forEach((v) => v.forEach((x, k) => (c[k] += x / verts.length)));
    verts.forEach((v) => v.forEach((x, k) => (v[k] = x - c[k])));
    const r = Math.hypot(...verts[0]);
    verts.forEach((v) => v.forEach((x, k) => (v[k] = x / r)));
    for (let i = 0; i < verts.length; i++) {
      for (let j = i + 1; j < verts.length; j++) edges.push([i, j, -1]);
    }
    // Layer 1 lights the root edge (v0, v1); layer L lights vertex L.
    for (let L = 1; L <= N; L++) {
      const set = L === 1 ? [0, 1] : [L];
      sets.push([set, set]);
    }
  } else {
    // Orthoplex: 2N vertices at ±e_k (already unit radius).
    for (let k = 0; k < N; k++) {
      const p = new Array(N).fill(0);
      const n = new Array(N).fill(0);
      p[k] = 1;
      n[k] = -1;
      verts.push(p, n);
    }
    // Every pair except antipodal partners (2k, 2k+1).
    for (let i = 0; i < verts.length; i++) {
      for (let j = i + 1; j < verts.length; j++) {
        if (i >> 1 !== j >> 1) edges.push([i, j, -1]);
      }
    }
    // In 1D the only two vertices are antipodal; draw the segment anyway.
    if (N === 1) edges.push([0, 1, 0]);
    for (let L = 1; L <= N; L++) sets.push([[2 * (L - 1)], [2 * (L - 1) + 1]]);
  }

  const V = verts.length;
  const base = new Float64Array(V * N);
  verts.forEach((v, idx) => v.forEach((x, k) => (base[idx * N + k] = x)));
  const flatEdges = new Int16Array(edges.length * 3);
  edges.forEach((e, idx) => flatEdges.set(e, idx * 3));
  return { N, V, E: edges.length, base, edges: flatEdges, sets };
}

// Per-geometry render buffers (reallocated only when the polytope changes)
let geo;
let sx, sy, sz, sw, sp, vGlow, vHue, edgeDepth, edgeOrder;

function rebuildGeometry() {
  geo = buildGeometry(state.family, state.dim);
  sx = new Float32Array(geo.V);
  sy = new Float32Array(geo.V);
  sz = new Float32Array(geo.V); // depth along Z after higher-D projection
  sw = new Float32Array(geo.V); // mean higher-dimensional depth (W, V, U)
  sp = new Float32Array(geo.V); // cumulative perspective factor
  vGlow = new Float32Array(geo.V);
  vHue = new Float32Array(geo.V).fill(FAMILIES[state.family].hue);
  edgeDepth = new Float32Array(geo.E);
  edgeOrder = Array.from({ length: geo.E }, (_, i) => i);
}

// ---------------------------------------------------------------------------
// Rotation + scale-preserving perspective projection
// ---------------------------------------------------------------------------

const tmp = new Float64Array(MAX_DIM);
const activePlanes = []; // reused: { i, j, c, s }
for (let p = 0; p < PLANES.length; p++) activePlanes.push({ i: 0, j: 0, c: 1, s: 0 });

function transformVertices() {
  const N = geo.N;

  // Gather active planes and their current angles (drift + interactive).
  let planeCount = 0;
  for (let p = 0; p < PLANES.length; p++) {
    const P = PLANES[p];
    if (P.i >= N || P.j >= N) continue;
    let angle = driftAngles[p] + rot.yaw * P.yaw + rot.pitch * P.pitch;
    if (N === 2) angle += rot.yaw + rot.pitch; // XY is the only plane in 2D
    const ap = activePlanes[planeCount++];
    ap.i = P.i;
    ap.j = P.j;
    ap.c = Math.cos(angle);
    ap.s = Math.sin(angle);
  }

  const base = geo.base;
  for (let v = 0; v < geo.V; v++) {
    const off = v * N;
    for (let k = 0; k < N; k++) tmp[k] = base[off + k];

    // Successive Givens rotations in each active plane.
    for (let p = 0; p < planeCount; p++) {
      const { i, j, c, s } = activePlanes[p];
      const a = tmp[i];
      const b = tmp[j];
      tmp[i] = c * a - s * b;
      tmp[j] = s * a + c * b;
    }

    // Mean higher-dimensional depth before projection.
    let hd = 0;
    for (let k = 3; k < N; k++) hd += tmp[k];
    sw[v] = N > 3 ? hd / (N - 3) : 0;

    // Project N → N-1 → … → 2. Factor d/(d − x_k) is 1 at x_k = 0, so the
    // shape keeps its scale instead of shrinking at every reduction step.
    let persp = 1;
    let depth = 0;
    for (let k = N - 1; k >= 2; k--) {
      const xk = Math.min(tmp[k], PERSPECTIVE_CLAMP);
      if (k === 2) depth = xk;
      const f = CAMERA_D / (CAMERA_D - xk);
      for (let j = 0; j < k; j++) tmp[j] *= f;
      persp *= f;
    }

    sx[v] = tmp[0];
    sy[v] = N > 1 ? tmp[1] : 0;
    sz[v] = depth;
    sp[v] = persp;
  }
}

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
let W = 0;
let H = 0;
let dpr = 1;

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);
resize();

// ---------------------------------------------------------------------------
// Pointer / touch rotation
// ---------------------------------------------------------------------------

const drag = { id: null, x: 0, y: 0, t: 0 };
const DRAG_GAIN = 0.008;

canvas.addEventListener('pointerdown', (e) => {
  if (drag.id !== null) return;
  drag.id = e.pointerId;
  drag.x = e.clientX;
  drag.y = e.clientY;
  drag.t = performance.now();
  rot.yawVel = 0;
  rot.pitchVel = 0;
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add('dragging');
});

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId !== drag.id) return;
  const now = performance.now();
  const dt = Math.max(1, now - drag.t) / 1000;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  drag.x = e.clientX;
  drag.y = e.clientY;
  drag.t = now;
  rot.yaw += dx * DRAG_GAIN;
  rot.pitch += dy * DRAG_GAIN;
  // Smoothed velocity for inertia after release.
  rot.yawVel = rot.yawVel * 0.6 + ((dx * DRAG_GAIN) / dt) * 0.4;
  rot.pitchVel = rot.pitchVel * 0.6 + ((dy * DRAG_GAIN) / dt) * 0.4;
  dragEnergy = Math.min(1, dragEnergy + (Math.abs(dx) + Math.abs(dy)) * 0.004);
});

function endDrag(e) {
  if (e.pointerId !== drag.id) return;
  drag.id = null;
  canvas.classList.remove('dragging');
  // No inertia if the pointer rested before release.
  if (performance.now() - drag.t > 80) {
    rot.yawVel = 0;
    rot.pitchVel = 0;
  }
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// ---------------------------------------------------------------------------
// Audio engine
// ---------------------------------------------------------------------------

const transport = Tone.getTransport();
const draw = Tone.getDraw(); // same object as the (deprecated) Tone.Draw export

/** Six timbrally distinct polyphonic voices, one per dimensional layer. */
const VOICE_DEFS = [
  // L1 — warm detuned bass root
  {
    volume: -7,
    oscillator: { type: 'fatsine', count: 3, spread: 14 },
    envelope: { attack: 0.05, decay: 0.8, sustain: 0.55, release: 2.4 },
  },
  // L2 — soft triangle pad pulses
  {
    volume: -11,
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.03, decay: 0.45, sustain: 0.35, release: 1.5 },
  },
  // L3 — chorused mid arpeggio
  {
    volume: -14,
    oscillator: { type: 'fattriangle', count: 2, spread: 18 },
    envelope: { attack: 0.025, decay: 0.35, sustain: 0.25, release: 1.2 },
  },
  // L4 — pure sine bell
  {
    volume: -12,
    oscillator: { type: 'sine' },
    envelope: { attack: 0.015, decay: 0.6, sustain: 0.12, release: 1.6 },
  },
  // L5 — amplitude-modulated shimmer
  {
    volume: -16,
    oscillator: { type: 'amsine', harmonicity: 2 },
    envelope: { attack: 0.012, decay: 0.35, sustain: 0.1, release: 1.4 },
  },
  // L6 — glassy FM sparkle
  {
    volume: -18,
    oscillator: { type: 'fmsine', harmonicity: 3, modulationIndex: 1.2 },
    envelope: { attack: 0.01, decay: 0.3, sustain: 0.05, release: 1.8 },
  },
];

let audio = null;
let measureCount = 0;
let loop = null;

function createVoices(destination) {
  return VOICE_DEFS.map(({ volume, ...options }) =>
    new Tone.PolySynth({ voice: Tone.Synth, maxPolyphony: 12, volume, options }).connect(
      destination,
    ),
  );
}

function buildAudio() {
  const limiter = new Tone.Limiter(-2).toDestination();
  const master = new Tone.Gain(0).connect(limiter); // fades for mute / unmute
  const reverb = new Tone.Reverb({ decay: 6, preDelay: 0.02, wet: 0.32 }).connect(master);
  const delay = new Tone.FeedbackDelay({ delayTime: '8n.', feedback: 0.32, wet: 0.2 }).connect(
    reverb,
  );
  const filter = new Tone.Filter({ type: 'lowpass', frequency: 1800, Q: 0.8, rolloff: -12 }).connect(
    delay,
  );
  return {
    limiter,
    master,
    reverb,
    delay,
    filter,
    voices: createVoices(filter),
    lastCutoff: 1800,
    lastWet: 0.2,
  };
}

/** Convert a 7-degree chord offset into a MIDI note within the active scale. */
function degreeToMidi(layer, degree7) {
  const steps = SCALES[state.scale].steps;
  const L = steps.length;
  const deg = Math.round((degree7 * L) / 7); // map 7-note degrees onto 5-note scales
  const oct = Math.floor(deg / L);
  const idx = ((deg % L) + L) % L;
  return LAYER_BASE_MIDI[layer - 1] + 12 * oct + steps[idx];
}

/** Rotation-dependent pattern offset: dragging the shape re-voices the arpeggios. */
function rotationShift() {
  const s = Math.floor((rot.yaw + rot.pitch) / (Math.PI / 4));
  return ((s % 64) + 64) % 64;
}

/**
 * The single master measure callback. Every pulse of every active layer is
 * placed at an exact audio-clock time inside this measure.
 */
function onMeasure(measureStartTime) {
  if (!audio || !audio.voices) return;
  const N = state.dim;
  const measureSeconds = Tone.Time('1m').toSeconds();
  const measure = measureCount++;
  const root = PROGRESSION[measure % PROGRESSION.length];
  const bassRoot = ((root % 7) + 7) % 7; // bass always climbs up from C2
  const shift = rotationShift();
  const gainScale = 1 / (0.55 + 0.45 * N); // inverse to N: 6D never clips or muddies

  for (let si = 0; si < STREAMS.length; si++) {
    const stream = STREAMS[si];
    if (stream.layer > N) continue;
    const { layer, R, pattern } = stream;
    const voice = audio.voices[layer - 1];
    const step = measureSeconds / R;
    const dur = layer === 1 ? measureSeconds * 0.92 : step * 0.6;

    for (let i = 0; i < R; i++) {
      const triggerTime = measureStartTime + (i / R) * measureSeconds;
      const offset = pattern[(i + shift) % pattern.length];
      const midi = layer === 1 ? degreeToMidi(1, bassRoot) : degreeToMidi(layer, root + offset);
      const accent = i === 0 ? 1.15 : 1;
      const velocity = clamp(LAYER_VELOCITY[layer - 1] * accent * gainScale, 0.05, 1);

      voice.triggerAttackRelease(Tone.Frequency(midi, 'midi').toFrequency(), dur, triggerTime, velocity);
      draw.schedule(() => onPulse(si, i), triggerTime);
    }
  }
}

/** Visual counterpart of a scheduled note, fired in sync by Tone.Draw. */
function onPulse(si, i) {
  const { layer, R } = STREAMS[si];
  if (layer > geo.N) return; // dimension was lowered mid-measure
  const parity = layer === 2 ? (R === 2 ? 0 : 1) : i % 2;
  const set = geo.sets[layer]?.[parity];
  if (set) {
    const hue = LAYER_HUE[layer - 1];
    for (const v of set) {
      vGlow[v] = 1;
      vHue[v] = hue;
    }
  }
  axisGlow[layer - 1] = 1;
  streamTicks[si][i] = 1;
  if (si === 0 && i === 0) lockFlash = 1; // every ratio coincides on the downbeat
}

function setPlaying(on) {
  if (!audio || on === state.playing) return;
  state.playing = on;
  const now = Tone.now();
  audio.master.gain.cancelScheduledValues(now);

  if (on) {
    if (!audio.voices) audio.voices = createVoices(audio.filter);
    measureCount = 0;
    audio.master.gain.rampTo(1, 0.4, now);
    transport.start('+0.08');
  } else {
    transport.stop();
    draw.cancel(0);
    audio.master.gain.rampTo(0, 0.25, now);
    // A full measure is scheduled ahead of time. PolySynth defers future notes
    // with context timers that are skipped once disposed, so retiring the
    // voices cancels the remainder of the measure cleanly.
    const old = audio.voices;
    audio.voices = null;
    old.forEach((v) => v.volume.rampTo(-60, 0.08));
    setTimeout(() => old.forEach((v) => v.dispose()), 200);
    streamTicks.forEach((t) => t.fill(0));
  }
  updateTransportButton();
}

// Throttled, ramped modulation from rotation + higher-dimensional depth.
let lastModTime = 0;
function modulateAudio(now, hdNorm) {
  if (!audio || !state.playing || now - lastModTime < 60) return;
  lastModTime = now;

  const t = clamp(0.42 + 0.28 * hdNorm + 0.18 * Math.sin(rot.yaw) + 0.35 * dragEnergy, 0, 1);
  const cutoff = 250 * Math.pow(6500 / 250, t); // exponential 250 Hz → 6.5 kHz
  if (Math.abs(cutoff - audio.lastCutoff) / audio.lastCutoff > 0.015) {
    audio.filter.frequency.rampTo(cutoff, 0.05);
    audio.lastCutoff = cutoff;
  }

  const wet = clamp(
    0.1 + 0.22 * Math.abs(Math.sin(rot.pitch)) + 0.12 * Math.abs(hdNorm) + 0.15 * dragEnergy,
    0,
    0.55,
  );
  if (Math.abs(wet - audio.lastWet) > 0.01) {
    audio.delay.wet.rampTo(wet, 0.1);
    audio.lastWet = wet;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function measurePhase() {
  if (!audio || transport.state !== 'started') return 0;
  const ticksPerMeasure = Tone.Time('1m').toTicks();
  const ticks = transport.getTicksAtTime(Tone.immediate());
  return (((ticks % ticksPerMeasure) + ticksPerMeasure) % ticksPerMeasure) / ticksPerMeasure;
}

function drawPolytope(cx, cy, R) {
  const famHue = FAMILIES[state.family].hue;
  const edges = geo.edges;

  // Depth-sort edges far → near.
  for (let e = 0; e < geo.E; e++) {
    edgeDepth[e] = (sz[edges[e * 3]] + sz[edges[e * 3 + 1]]) * 0.5;
  }
  edgeOrder.sort((a, b) => edgeDepth[a] - edgeDepth[b]);

  ctx.lineCap = 'round';
  for (let n = 0; n < geo.E; n++) {
    const e = edgeOrder[n];
    const a = edges[e * 3];
    const b = edges[e * 3 + 1];
    const axis = edges[e * 3 + 2];
    const near = clamp((edgeDepth[e] + 1) * 0.5, 0, 1);
    const w = (sw[a] + sw[b]) * 0.5;
    const g = Math.max((vGlow[a] + vGlow[b]) * 0.5, axis >= 0 ? axisGlow[axis] * 0.85 : 0);
    const pulseHue = vGlow[a] >= vGlow[b] ? vHue[a] : vHue[b];
    const hue = famHue + w * 90 + (pulseHue - famHue) * Math.min(1, g * 0.8);
    const light = 42 + near * 18 + g * 30;
    const alpha = 0.12 + near * 0.33 + g * 0.5;
    const width = (0.6 + near * 1.4 + g * 2.6) * Math.sqrt((sp[a] + sp[b]) * 0.5);
    const x1 = cx + sx[a] * R;
    const y1 = cy - sy[a] * R;
    const x2 = cx + sx[b] * R;
    const y2 = cy - sy[b] * R;

    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = `hsla(${hue}, 85%, ${light}%, ${alpha})`;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    if (g > 0.08) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = `hsla(${hue}, 100%, 65%, ${g * 0.22})`;
      ctx.lineWidth = width * 4;
      ctx.stroke();
    }
  }

  // Glowing vertices (additive).
  ctx.globalCompositeOperation = 'lighter';
  for (let v = 0; v < geo.V; v++) {
    const near = clamp((sz[v] + 1) * 0.5, 0, 1);
    const g = vGlow[v];
    const hue = famHue + sw[v] * 90 + (vHue[v] - famHue) * Math.min(1, g);
    const scale = Math.sqrt(sp[v]);
    const r = (1.6 + near * 2.2 + g * 4) * scale;
    const x = cx + sx[v] * R;
    const y = cy - sy[v] * R;

    const halo = r * (3.5 + g * 4);
    const grad = ctx.createRadialGradient(x, y, 0, x, y, halo);
    grad.addColorStop(0, `hsla(${hue}, 95%, 65%, ${0.18 + g * 0.5})`);
    grad.addColorStop(1, `hsla(${hue}, 95%, 50%, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, halo, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = `hsla(${hue}, 100%, ${78 + g * 18}%, ${0.75 + g * 0.25})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Downbeat lock: an expanding halo around the whole polytope.
  if (lockFlash > 0.01) {
    ctx.strokeStyle = `hsla(${famHue}, 90%, 75%, ${lockFlash * 0.3})`;
    ctx.lineWidth = 1 + lockFlash * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, R * (1.08 + (1 - lockFlash) * 0.35), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
}

/** Concentric polyrhythm rings: one ring per stream, R ticks each, a shared playhead. */
function drawRhythmRings(phase) {
  const streams = activeStreams(state.dim);
  const ringStep = 8;
  const inner = 14;
  const outer = inner + (STREAMS.length - 1) * ringStep;
  const margin = 22;
  const cx = W - outer - margin;
  const cy = H - outer - margin - 10;
  const TAU = Math.PI * 2;

  ctx.globalCompositeOperation = 'source-over';

  // Lock flash: rings align at 12 o'clock on the downbeat.
  if (lockFlash > 0.01) {
    ctx.strokeStyle = `rgba(220, 235, 255, ${lockFlash * 0.45})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, outer + 6 + (1 - lockFlash) * 14, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = `rgba(255, 255, 255, ${lockFlash * 0.8})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy - inner + 4);
    ctx.lineTo(cx, cy - outer - 6);
    ctx.stroke();
  }

  for (let k = 0; k < STREAMS.length; k++) {
    const s = STREAMS[k];
    const r = inner + k * ringStep;
    const active = s.layer <= state.dim;
    const hue = LAYER_HUE[s.layer - 1];
    ctx.strokeStyle = active ? `hsla(${hue}, 60%, 60%, 0.18)` : 'rgba(120, 130, 160, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.stroke();
    if (!active) continue;

    const ticks = streamTicks[k];
    for (let i = 0; i < s.R; i++) {
      const ang = -Math.PI / 2 + (TAU * i) / s.R;
      const g = ticks[i];
      ctx.fillStyle = `hsla(${hue}, 90%, ${55 + g * 35}%, ${0.35 + g * 0.65})`;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r, 1.4 + g * 2.4, 0, TAU);
      ctx.fill();
    }
  }

  // Playhead
  if (state.playing) {
    const ang = -Math.PI / 2 + TAU * phase;
    ctx.strokeStyle = 'rgba(230, 240, 255, 0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ang) * (inner - 6), cy + Math.sin(ang) * (inner - 6));
    ctx.lineTo(cx + Math.cos(ang) * (outer + 4), cy + Math.sin(ang) * (outer + 4));
    ctx.stroke();
  }

  ctx.fillStyle = 'rgba(200, 212, 245, 0.7)';
  ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(streams.length > 1 ? ratioLabel(state.dim) : '1 : root', cx, cy + outer + 10);
}

// ---------------------------------------------------------------------------
// Frame loop (visuals only — audio timing lives on the Tone.js clock)
// ---------------------------------------------------------------------------

let lastFrame = performance.now();

function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  // Autonomous drift + post-drag inertia.
  for (let p = 0; p < PLANES.length; p++) {
    const speed = state.dim === 2 && p === 0 ? 0.25 : PLANES[p].drift;
    driftAngles[p] += speed * dt;
  }
  if (drag.id === null) {
    rot.yaw += rot.yawVel * dt;
    rot.pitch += rot.pitchVel * dt;
    const damp = Math.exp(-dt * 2.5);
    rot.yawVel *= damp;
    rot.pitchVel *= damp;
  }
  dragEnergy *= Math.exp(-dt * 1.6);

  // Decay pulse glows.
  const vDecay = Math.exp(-dt * 5);
  for (let v = 0; v < geo.V; v++) vGlow[v] *= vDecay;
  const aDecay = Math.exp(-dt * 4);
  for (let k = 0; k < MAX_DIM; k++) {
    axisGlow[k] *= aDecay;
  }
  const tDecay = Math.exp(-dt * 3);
  for (const t of streamTicks) for (let i = 0; i < t.length; i++) t[i] *= tDecay;
  lockFlash *= Math.exp(-dt * 2.5);

  transformVertices();

  // Glow-weighted higher-dimensional depth (falls back to vertex 0 when idle).
  let num = sw[0] * 0.3;
  let den = 0.3;
  for (let v = 0; v < geo.V; v++) {
    num += sw[v] * vGlow[v];
    den += vGlow[v];
  }
  const hdNorm = clamp((num / den) * 1.8, -1, 1);

  // Motion-blur trails: fade previous frame towards transparent (CSS cosmos shows through).
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = `rgba(0, 0, 0, ${1 - Math.pow(0.76, dt * 60)})`;
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'source-over';

  const R = Math.min(W, H) * 0.28 * (1 + lockFlash * 0.035);
  drawPolytope(W / 2, H / 2, R);
  drawRhythmRings(measurePhase());

  modulateAudio(now, hdNorm);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

const hud = document.getElementById('hud');
hud.classList.add('hidden-until-enter');

const segmented = (name, entries, current) =>
  `<div class="segmented" data-group="${name}">${Object.entries(entries)
    .map(
      ([key, { label }]) =>
        `<button type="button" data-value="${key}" class="${key === current ? 'active' : ''}">${label}</button>`,
    )
    .join('')}</div>`;

hud.innerHTML = `
  <div class="hud-head">
    <span class="hud-title">N-Dimensional Synth</span>
    <button type="button" class="hud-collapse" aria-label="Collapse controls">–</button>
  </div>
  <div class="hud-body">
    <div class="readout" id="readout"></div>
    <div class="sub-readout" id="sub-readout"></div>

    <div class="field">
      <div class="field-label"><span>Dimension</span><span id="dim-value"></span></div>
      <input id="dim" type="range" min="1" max="${MAX_DIM}" step="1" value="${state.dim}" />
      <div class="ticks">${Array.from({ length: MAX_DIM }, (_, i) => `<span>${i + 1}D</span>`).join('')}</div>
    </div>

    <div class="field">
      <div class="field-label"><span>Polytope</span></div>
      ${segmented('family', FAMILIES, state.family)}
    </div>

    <div class="field">
      <div class="field-label"><span>Scale</span></div>
      ${segmented('scale', SCALES, state.scale)}
    </div>

    <div class="field">
      <div class="field-label"><span>Tempo</span><span id="bpm-value"></span></div>
      <input id="bpm" type="range" min="60" max="160" step="1" value="${state.bpm}" />
    </div>

    <button type="button" class="transport-btn" id="transport"></button>
    <div class="hint">Drag the space to rotate · Higher dimensions add pulses</div>
  </div>
`;

// Prevent input bleed: nothing inside the HUD should reach the canvas / window.
for (const type of ['pointerdown', 'pointermove', 'pointerup', 'touchstart', 'touchmove', 'wheel']) {
  hud.addEventListener(type, (e) => e.stopPropagation(), { passive: true });
}

const $ = (id) => document.getElementById(id);

function updateReadout() {
  const N = state.dim;
  const fam = FAMILIES[state.family];
  const planes = PLANES.filter((p) => p.i < N && p.j < N).length;
  $('readout').innerHTML = `${N}D ${fam.names[N - 1]} — <span class="ratio">${ratioLabel(N)}</span>`;
  $('sub-readout').textContent = `${geo.V} vertices · ${geo.E} edges · ${planes} rotation plane${planes === 1 ? '' : 's'}`;
  $('dim-value').textContent = `${N}D`;
  $('bpm-value').textContent = `${state.bpm} BPM`;
}

function updateTransportButton() {
  const btn = $('transport');
  btn.textContent = state.playing ? '❚❚  Pause / Mute' : '▶  Play';
  btn.classList.toggle('paused', !state.playing);
}

$('dim').addEventListener('input', (e) => {
  state.dim = Number(e.target.value);
  rebuildGeometry();
  updateReadout();
});

$('bpm').addEventListener('input', (e) => {
  state.bpm = Number(e.target.value);
  transport.bpm.value = state.bpm;
  updateReadout();
});

hud.querySelectorAll('.segmented').forEach((group) => {
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-value]');
    if (!btn) return;
    const key = group.dataset.group;
    state[key] = btn.dataset.value;
    group.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
    if (key === 'family') rebuildGeometry();
    updateReadout();
  });
});

$('transport').addEventListener('click', () => setPlaying(!state.playing));

hud.querySelector('.hud-collapse').addEventListener('click', (e) => {
  const collapsed = hud.classList.toggle('collapsed');
  e.currentTarget.textContent = collapsed ? '+' : '–';
  e.currentTarget.setAttribute('aria-label', collapsed ? 'Expand controls' : 'Collapse controls');
});

// ---------------------------------------------------------------------------
// Autoplay-compliant entry overlay
// ---------------------------------------------------------------------------

const overlay = document.getElementById('overlay');
let entering = false;

async function enter() {
  if (entering) return;
  entering = true;
  try {
    await Tone.start(); // must be the first await inside the user gesture
  } catch (err) {
    console.error('Audio context could not start:', err);
    entering = false;
    return;
  }

  audio = buildAudio();
  transport.bpm.value = state.bpm;
  transport.timeSignature = 4;
  loop = new Tone.Loop((measureStartTime) => onMeasure(measureStartTime), '1m').start(0);
  try {
    await audio.reverb.ready;
  } catch {
    /* reverb impulse failed — dry path still works */
  }
  setPlaying(true);

  overlay.classList.add('fade');
  hud.classList.remove('hidden-until-enter');
  overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
}

overlay.addEventListener('click', enter);
overlay.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    enter();
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

rebuildGeometry();
updateReadout();
updateTransportButton();
requestAnimationFrame(frame);
