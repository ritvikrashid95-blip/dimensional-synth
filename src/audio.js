// ─── Tone.js Hydrophone Synthesizer & Spatial Effects Bus ──────────
import * as Tone from 'tone';

// ─── Musical Scales (semitone offsets from root) ───────────────────
const SCALES = {
  'Pentatonic Minor': [0, 3, 5, 7, 10],
  'Lydian':           [0, 2, 4, 6, 7, 9, 11],
  'Hirajoshi':        [0, 2, 3, 7, 8],
  'Harmonic Major':   [0, 2, 4, 5, 7, 8, 11],
};

const BASE_MIDI = 48; // C3
const OCTAVES = 3;

function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

function quantize(midiRaw, scaleOffsets) {
  let best = 200, bestMidi = midiRaw;
  const lo = BASE_MIDI;
  const hi = BASE_MIDI + OCTAVES * 12;
  for (let oct = 0; oct < OCTAVES + 1; oct++) {
    for (const off of scaleOffsets) {
      const m = lo + oct * 12 + off;
      if (m > hi) continue;
      if (Math.abs(m - midiRaw) < Math.abs(best - midiRaw)) {
        best = m;
        bestMidi = m;
      }
    }
  }
  return bestMidi;
}

function midiToNoteName(midi) {
  const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const oct = Math.floor(midi / 12) - 1;
  return names[midi % 12] + oct;
}

// ─── Hydrophone Probe ──────────────────────────────────────────────
class Hydrophone {
  constructor(id, gridX, gridY, pan, bus) {
    this.id = id;
    this.gridX = gridX;
    this.gridY = gridY;
    this.pan = pan;
    this.currentNote = 'C3';
    this.currentMidi = 48;
    this.amplitude = 0;

    // Continuous harmonic drone voice
    this.drone = new Tone.FMSynth({
      harmonicity: 2.5,
      modulationIndex: 4,
      oscillator: { type: 'sine' },
      modulation: { type: 'triangle' },
      envelope: { attack: 0.3, decay: 0.4, sustain: 0.6, release: 1.0 },
      modulationEnvelope: { attack: 0.4, decay: 0.3, sustain: 0.5, release: 0.8 },
      volume: -28,
    });

    // Crest chime trigger
    this.chime = new Tone.Synth({
      oscillator: { type: 'triangle8' },
      envelope: { attack: 0.005, decay: 0.25, sustain: 0.0, release: 0.4 },
      volume: -18,
    });

    // Per-probe panner
    this.panner = new Tone.Panner(pan);

    this.drone.connect(this.panner);
    this.chime.connect(this.panner);
    this.panner.connect(bus);

    this._crestCooldown = 0;
    this._droneActive = false;
    this._prevHeight = 0;
    this._crestThreshold = 0.15;
  }

  updatePitch(scaleName) {
    const N = 160;
    const scaleOffsets = SCALES[scaleName] || SCALES['Pentatonic Minor'];
    // Map Y position → MIDI note (top = high, bottom = low)
    const rawMidi = BASE_MIDI + (1 - this.gridY / N) * OCTAVES * 12;
    this.currentMidi = quantize(rawMidi, scaleOffsets);
    this.currentNote = midiToNoteName(this.currentMidi);
    const freq = midiToFreq(this.currentMidi);
    this.drone.frequency.rampTo(freq, 0.15);
  }

  updatePan() {
    const N = 160;
    this.pan = (this.gridX / N) * 1.7 - 0.85; // -0.85 to +0.85
    this.panner.pan.rampTo(this.pan, 0.1);
  }

  /** Called every frame with the wave height at this probe's location. */
  tick(height, now) {
    this.amplitude = Math.abs(height);
    const gain = Math.min(this.amplitude * 8, 1);

    // Drone volume follows amplitude
    const droneVol = -28 + gain * 22; // -28dB to -6dB
    this.drone.volume.rampTo(droneVol, 0.05);

    if (!this._droneActive && this.amplitude > 0.01) {
      this.drone.triggerAttack(midiToFreq(this.currentMidi));
      this._droneActive = true;
    }

    // Crest detection: rising past threshold with cooldown
    if (height > this._crestThreshold && this._prevHeight <= this._crestThreshold) {
      if (now - this._crestCooldown > 0.11) {
        this.chime.triggerAttackRelease(midiToFreq(this.currentMidi), '16n');
        this._crestCooldown = now;
      }
    }
    this._prevHeight = height;
  }

  dispose() {
    if (this._droneActive) this.drone.triggerRelease();
    this.drone.disconnect();
    this.chime.disconnect();
    this.panner.disconnect();
    this.drone.dispose();
    this.chime.dispose();
    this.panner.dispose();
  }
}

// ─── Hydrophone Engine (5 probes + master bus) ─────────────────────
export class HydrophoneEngine {
  constructor() {
    this.ready = false;
    this.scaleName = 'Pentatonic Minor';
    this.probes = [];
    this._masterBus = null;
  }

  async init() {
    await Tone.start();

    // Master effects bus
    const filter = new Tone.Filter({ frequency: 3500, type: 'lowpass', rolloff: -24 });
    const delay  = new Tone.PingPongDelay({ delayTime: '8n.', feedback: 0.35, wet: 0.2 });
    const reverb = new Tone.Reverb({ decay: 4.5, wet: 0.4, preDelay: 0.05 });
    const comp   = new Tone.Compressor({ threshold: -18, ratio: 4, attack: 0.01, release: 0.15 });
    const limiter = new Tone.Limiter(-3);

    this._filter = filter;
    this._masterBus = new Tone.Gain(1);
    this._masterBus.chain(filter, delay, reverb, comp, limiter, Tone.getDestination());

    // Default hydrophone positions (spread across grid)
    const N = 160;
    const defaults = [
      { x: N * 0.25, y: N * 0.3 },
      { x: N * 0.75, y: N * 0.3 },
      { x: N * 0.5,  y: N * 0.5 },
      { x: N * 0.3,  y: N * 0.72 },
      { x: N * 0.7,  y: N * 0.72 },
    ];

    for (let i = 0; i < 5; i++) {
      const { x, y } = defaults[i];
      const pan = (x / N) * 1.7 - 0.85;
      const h = new Hydrophone(`H${i + 1}`, Math.round(x), Math.round(y), pan, this._masterBus);
      h.updatePitch(this.scaleName);
      this.probes.push(h);
    }

    this.ready = true;
  }

  setScale(name) {
    this.scaleName = name;
    for (const p of this.probes) p.updatePitch(name);
  }

  /** Called once per animation frame with the wave solver's uCurr buffer. */
  tick(uCurr, N) {
    if (!this.ready) return;
    const now = Tone.now();

    let totalEnergy = 0;
    for (const p of this.probes) {
      const gx = Math.round(p.gridX);
      const gy = Math.round(p.gridY);
      if (gx >= 0 && gx < N && gy >= 0 && gy < N) {
        const h = uCurr[gy * N + gx];
        p.tick(h, now);
        totalEnergy += p.amplitude;
      }
    }

    // Modulate filter cutoff with total energy
    const cutoff = 1200 + Math.min(totalEnergy * 3, 1) * 4500;
    this._filter.frequency.rampTo(cutoff, 0.1);
  }

  moveProbe(index, gx, gy) {
    const p = this.probes[index];
    if (!p) return;
    p.gridX = gx;
    p.gridY = gy;
    p.updatePan();
    p.updatePitch(this.scaleName);
  }

  getScaleNames() { return Object.keys(SCALES); }
}
