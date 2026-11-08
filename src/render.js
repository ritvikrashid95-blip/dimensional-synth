// ─── Topographic Contour & Duotone Height-Map Renderer ─────────────

// Palette key-stops: trough → crest
// Deep navy/teal → bioluminescent cyan → warm amber/coral
const PALETTE = buildPalette();

function buildPalette() {
  // 256-entry lookup: index 0 = deepest trough, 255 = highest crest
  const stops = [
    { t: 0.00, r: 4,   g: 11,  b: 20  }, // #040b14  deep navy
    { t: 0.25, r: 8,   g: 40,  b: 58  }, // #08283a
    { t: 0.40, r: 13,  g: 59,  b: 76  }, // #0d3b4c  marine teal
    { t: 0.50, r: 10,  g: 48,  b: 60  }, // neutral midpoint
    { t: 0.60, r: 0,   g: 160, b: 200 }, // #00a0c8  bioluminescent cyan
    { t: 0.72, r: 0,   g: 210, b: 255 }, // #00d2ff  bright cyan
    { t: 0.85, r: 255, g: 107, b: 53  }, // #ff6b35  warm amber
    { t: 1.00, r: 255, g: 243, b: 224 }, // #fff3e0  coral white
  ];

  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    // Find surrounding stops
    let lo = stops[0], hi = stops[stops.length - 1];
    for (let s = 0; s < stops.length - 1; s++) {
      if (t >= stops[s].t && t <= stops[s + 1].t) {
        lo = stops[s]; hi = stops[s + 1]; break;
      }
    }
    const f = (hi.t === lo.t) ? 0 : (t - lo.t) / (hi.t - lo.t);
    lut[i * 3]     = Math.round(lo.r + (hi.r - lo.r) * f);
    lut[i * 3 + 1] = Math.round(lo.g + (hi.g - lo.g) * f);
    lut[i * 3 + 2] = Math.round(lo.b + (hi.b - lo.b) * f);
  }
  return lut;
}

// Wall colour: architectural slate
const WALL_R = 55, WALL_G = 65, WALL_B = 80;

// Contour thresholds (heights at which to draw rings)
const CONTOUR_LEVELS = [-0.8, -0.5, -0.3, -0.15, 0.15, 0.3, 0.5, 0.8];

export class WaveRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });

    // Offscreen buffer at grid resolution
    this._offCanvas = document.createElement('canvas');
    this._offCtx = this._offCanvas.getContext('2d', { alpha: false });
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width  = window.innerWidth * dpr;
    this.canvas.height = window.innerHeight * dpr;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
  }

  /**
   * Render the full frame.
   * @param {Float32Array} u     – wave field (N×N)
   * @param {Uint8Array}   walls – wall mask
   * @param {number}       N     – grid side length
   * @param {Array}        probes – hydrophone probe objects
   */
  draw(u, walls, N, probes) {
    const oc = this._offCanvas;
    if (oc.width !== N || oc.height !== N) {
      oc.width = N; oc.height = N;
    }
    const imgData = this._offCtx.createImageData(N, N);
    const px = imgData.data;

    // Normalise amplitude range for palette mapping
    let aMax = 0.5;
    for (let i = 0; i < N * N; i++) {
      const a = Math.abs(u[i]);
      if (a > aMax) aMax = a;
    }
    const invRange = 1 / aMax;

    for (let i = 0; i < N * N; i++) {
      const pi = i * 4;
      if (walls[i]) {
        px[pi]     = WALL_R;
        px[pi + 1] = WALL_G;
        px[pi + 2] = WALL_B;
        px[pi + 3] = 255;
        continue;
      }
      // Map height [-aMax, aMax] → [0, 255]
      const norm = (u[i] * invRange * 0.5 + 0.5);
      const ci = Math.max(0, Math.min(255, Math.round(norm * 255)));
      px[pi]     = PALETTE[ci * 3];
      px[pi + 1] = PALETTE[ci * 3 + 1];
      px[pi + 2] = PALETTE[ci * 3 + 2];
      px[pi + 3] = 255;
    }

    // Contour lines (thin, drawn into the image buffer)
    for (const level of CONTOUR_LEVELS) {
      const absLevel = level * aMax;
      for (let y = 1; y < N - 1; y++) {
        for (let x = 1; x < N - 1; x++) {
          const idx = y * N + x;
          if (walls[idx]) continue;
          const v = u[idx];
          // Check if contour crosses any neighbour
          const vr = u[idx + 1];
          const vd = u[idx + N];
          if ((v >= absLevel && vr < absLevel) || (v < absLevel && vr >= absLevel) ||
              (v >= absLevel && vd < absLevel) || (v < absLevel && vd >= absLevel)) {
            const pi = idx * 4;
            // Brighten / overlay contour
            px[pi]     = Math.min(255, px[pi] + 40);
            px[pi + 1] = Math.min(255, px[pi + 1] + 50);
            px[pi + 2] = Math.min(255, px[pi + 2] + 45);
          }
        }
      }
    }

    this._offCtx.putImageData(imgData, 0, 0);

    // Scale to full canvas
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    this.ctx.drawImage(oc, 0, 0, cw, ch);

    // Draw hydrophone overlays on main canvas
    this._drawProbes(probes, N, cw, ch);
  }

  _drawProbes(probes, N, cw, ch) {
    const ctx = this.ctx;
    const sx = cw / N;
    const sy = ch / N;

    for (const p of probes) {
      const px = p.gridX * sx;
      const py = p.gridY * sy;
      const pulseSz = 6 + p.amplitude * 55;

      // Amplitude pulse ring
      ctx.beginPath();
      ctx.arc(px, py, pulseSz * (cw / 800), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(0, 210, 255, ${0.25 + p.amplitude * 0.6})`;
      ctx.lineWidth = 1.5 * (cw / 800);
      ctx.stroke();

      // Outer reticle
      const retSz = 10 * (cw / 800);
      ctx.beginPath();
      ctx.arc(px, py, retSz, 0, Math.PI * 2);
      ctx.strokeStyle = '#00d2ff';
      ctx.lineWidth = 1.5 * (cw / 800);
      ctx.stroke();

      // Crosshair lines
      const cross = 15 * (cw / 800);
      ctx.beginPath();
      ctx.moveTo(px - cross, py); ctx.lineTo(px - retSz - 2, py);
      ctx.moveTo(px + retSz + 2, py); ctx.lineTo(px + cross, py);
      ctx.moveTo(px, py - cross); ctx.lineTo(px, py - retSz - 2);
      ctx.moveTo(px, py + retSz + 2); ctx.lineTo(px, py + cross);
      ctx.strokeStyle = 'rgba(0, 210, 255, 0.6)';
      ctx.lineWidth = 1 * (cw / 800);
      ctx.stroke();

      // Centre dot
      ctx.beginPath();
      ctx.arc(px, py, 2.5 * (cw / 800), 0, Math.PI * 2);
      ctx.fillStyle = '#00d2ff';
      ctx.fill();

      // Label
      const fontSize = Math.max(10, 12 * (cw / 800));
      ctx.font = `bold ${fontSize}px "JetBrains Mono", "Fira Code", monospace`;
      ctx.fillStyle = '#00d2ff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${p.id} · ${p.currentNote}`, px + cross + 2, py - 4);
    }
  }
}
