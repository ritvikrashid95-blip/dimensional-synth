// ─── 2D Wave Equation Solver & Obstacle Grid ───────────────────────
// Finite-difference 2D wave equation on a 160×160 grid.

const N = 160;
const SIZE = N * N;

export class WaveSolver {
  constructor() {
    this.N = N;
    this.uCurr = new Float32Array(SIZE);
    this.uPrev = new Float32Array(SIZE);
    this.uNext = new Float32Array(SIZE);
    this.walls = new Uint8Array(SIZE);

    // Tuneable parameters
    this.c2 = 0.22;       // wave speed squared (slider 0.10–0.35)
    this.damping = 0.992;  // energy damping     (slider 0.975–0.998)
  }

  /** idx helper */
  idx(x, y) { return y * N + x; }

  /** Advance one timestep of the 2D wave equation. */
  step() {
    const { uCurr, uPrev, uNext, walls, c2, damping } = this;
    for (let y = 1; y < N - 1; y++) {
      for (let x = 1; x < N - 1; x++) {
        const i = y * N + x;
        if (walls[i]) { uNext[i] = 0; continue; }
        const left  = i - 1;
        const right = i + 1;
        const up    = i - N;
        const down  = i + N;
        uNext[i] = (
          2 * uCurr[i] - uPrev[i] +
          c2 * (uCurr[left] + uCurr[right] + uCurr[up] + uCurr[down] - 4 * uCurr[i])
        ) * damping;
      }
    }
    // Absorbing / zero boundary
    for (let x = 0; x < N; x++) {
      uNext[x] = 0;                     // top row
      uNext[(N - 1) * N + x] = 0;       // bottom row
    }
    for (let y = 0; y < N; y++) {
      uNext[y * N] = 0;                 // left col
      uNext[y * N + N - 1] = 0;         // right col
    }

    // Rotate buffers
    const tmp = this.uPrev;
    this.uPrev = this.uCurr;
    this.uCurr = this.uNext;
    this.uNext = tmp;
  }

  /** Inject a smooth Gaussian pulse into uCurr. */
  dropStone(gx, gy, radius = 4, strength = 1.5) {
    const r2 = radius * radius;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = gx + dx;
        const y = gy + dy;
        if (x < 0 || x >= N || y < 0 || y >= N) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const i = y * N + x;
        if (this.walls[i]) continue;
        this.uCurr[i] += strength * Math.exp(-d2 / (2 * (radius * 0.45) ** 2));
      }
    }
  }

  /** Bresenham thick line wall rasterizer (width ~3). */
  setWallLine(x0, y0, x1, y1, erase = false) {
    const points = this._bresenham(x0, y0, x1, y1);
    const val = erase ? 0 : 1;
    const thick = 1; // ±1 gives 3-wide lines
    for (const [px, py] of points) {
      for (let dy = -thick; dy <= thick; dy++) {
        for (let dx = -thick; dx <= thick; dx++) {
          const nx = px + dx;
          const ny = py + dy;
          if (nx >= 0 && nx < N && ny >= 0 && ny < N) {
            this.walls[ny * N + nx] = val;
            if (val) { this.uCurr[ny * N + nx] = 0; }
          }
        }
      }
    }
  }

  _bresenham(x0, y0, x1, y1) {
    x0 = Math.round(x0); y0 = Math.round(y0);
    x1 = Math.round(x1); y1 = Math.round(y1);
    const pts = [];
    let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    while (true) {
      pts.push([x0, y0]);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
    return pts;
  }

  clearWaves() {
    this.uCurr.fill(0);
    this.uPrev.fill(0);
    this.uNext.fill(0);
  }

  clearWalls() {
    this.walls.fill(0);
  }

  // ─── Chamber Presets ─────────────────────────────────────────────

  /** Elliptical whispering gallery */
  presetEllipse() {
    this.clearWalls();
    const cx = N / 2, cy = N / 2;
    const rx = N * 0.42, ry = N * 0.32;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const ex = (x - cx) / rx;
        const ey = (y - cy) / ry;
        const d = ex * ex + ey * ey;
        if (d > 0.95 && d < 1.05) {
          this.walls[y * N + x] = 1;
        }
      }
    }
  }

  /** Harbor breakwater — two angled walls with a gap */
  presetHarbor() {
    this.clearWalls();
    // Left breakwater
    this.setWallLine(10, N * 0.65, N * 0.42, N * 0.45, false);
    // Right breakwater
    this.setWallLine(N - 10, N * 0.65, N * 0.58, N * 0.45, false);
    // Rear wall
    this.setWallLine(10, N * 0.65, N - 10, N * 0.65, false);
    // Dock jetties
    this.setWallLine(N * 0.25, N * 0.65, N * 0.25, N * 0.85, false);
    this.setWallLine(N * 0.75, N * 0.65, N * 0.75, N * 0.85, false);
  }

  /** Resonant cavity — rectangular with a narrow slit */
  presetCavity() {
    this.clearWalls();
    const m = 20, e = N - 20;
    // Top
    this.setWallLine(m, m, e, m, false);
    // Bottom
    this.setWallLine(m, e, e, e, false);
    // Left
    this.setWallLine(m, m, m, e, false);
    // Right wall with slit
    this.setWallLine(e, m, e, N * 0.42, false);
    this.setWallLine(e, N * 0.58, e, e, false);
  }
}
