/**
 * Deterministic-ish speech-like audio generator for VAD/wake-word smoke
 * tests. Pure synthesis (glottal pulse train through a three-formant
 * resonator bank with a syllable-rate amplitude envelope and mild f0
 * jitter) — close enough to real speech in the time/frequency domain that
 * the Silero VAD reads it as speech, without shipping a recorded WAV.
 *
 * `silence + speech + silence` is the canonical smoke fixture: the VAD
 * should detect exactly one speech segment whose boundaries land inside
 * the voiced region, and `VadDetector` should drop the leading/trailing
 * silence windows from its speech-state timeline.
 */

export interface SpeechFixtureOptions {
  sampleRate?: number;
  /** Seconds of leading silence. */
  leadSilenceSec?: number;
  /** Seconds of synthesized speech. */
  speechSec?: number;
  /** Seconds of trailing silence. */
  tailSilenceSec?: number;
  /** Deterministic seed for the f0 jitter. */
  seed?: number;
}

export interface SpeechFixture {
  pcm: Float32Array;
  sampleRate: number;
  speechStartSample: number;
  speechEndSample: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A three-formant resonator bank state. */
class FormantBank {
  private readonly r: number[];
  private readonly a1: number[];
  private readonly a2: number[];
  private readonly z1: number[];
  private readonly z2: number[];
  constructor(sampleRate: number, formants: ReadonlyArray<readonly [number, number]>) {
    this.r = [];
    this.a1 = [];
    this.a2 = [];
    this.z1 = [];
    this.z2 = [];
    for (const [fc, bw] of formants) {
      const r = Math.exp((-Math.PI * bw) / sampleRate);
      const theta = (2 * Math.PI * fc) / sampleRate;
      this.r.push(r);
      this.a1.push(-2 * r * Math.cos(theta));
      this.a2.push(r * r);
      this.z1.push(0);
      this.z2.push(0);
    }
  }
  step(excitation: number): number {
    let v = 0;
    for (let k = 0; k < this.r.length; k++) {
      const y = excitation - this.a1[k] * this.z1[k] - this.a2[k] * this.z2[k];
      this.z2[k] = this.z1[k];
      this.z1[k] = y;
      v += y * (1 - k * 0.25);
    }
    return v;
  }
}

const DEFAULT_FORMANTS: ReadonlyArray<readonly [number, number]> = [
  [700, 80],
  [1220, 90],
  [2600, 120],
];

/** Build a `silence + synthesized speech + silence` PCM buffer. */
export function makeSpeechWithSilenceFixture(
  opts: SpeechFixtureOptions = {},
): SpeechFixture {
  const sampleRate = opts.sampleRate ?? 16_000;
  const leadSec = opts.leadSilenceSec ?? 0.5;
  const speechSec = opts.speechSec ?? 1.2;
  const tailSec = opts.tailSilenceSec ?? 0.5;
  const totalSec = leadSec + speechSec + tailSec;
  const n = Math.floor(totalSec * sampleRate);
  const pcm = new Float32Array(n);
  const speechStartSample = Math.floor(leadSec * sampleRate);
  const speechEndSample = Math.floor((leadSec + speechSec) * sampleRate);

  const rng = mulberry32(opts.seed ?? 0xe11a);
  const bank = new FormantBank(sampleRate, DEFAULT_FORMANTS);
  let phase = 0;
  for (let i = speechStartSample; i < speechEndSample; i++) {
    const tInSpeech = (i - speechStartSample) / sampleRate;
    const f0 = 110 + 30 * Math.sin(2 * Math.PI * 5 * tInSpeech) + (rng() - 0.5) * 4;
    phase += f0 / sampleRate;
    let excitation = 0;
    if (phase >= 1) {
      phase -= 1;
      excitation = 1;
    }
    // Syllable-rate amplitude envelope (~4 Hz).
    const amp = Math.max(0, 0.6 * (1 + Math.sin(2 * Math.PI * 4 * tInSpeech - Math.PI / 2)));
    excitation *= amp;
    pcm[i] = bank.step(excitation) * 0.15;
  }
  return { pcm, sampleRate, speechStartSample, speechEndSample };
}
