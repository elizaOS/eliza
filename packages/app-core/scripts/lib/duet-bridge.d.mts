/**
 * Type declarations for `duet-bridge.mjs` — the in-memory audio routing for the
 * two-agents-talking-endlessly harness (`voice-duet.mjs`) and the
 * `voice-duet.e2e.test.ts` stub-backend wiring path.
 */

/**
 * Linear-interpolation resample of mono `Float32Array` PCM. Returns the input
 * unchanged when the rates already match.
 */
export function resampleLinear(pcm: Float32Array, fromRate: number, toRate: number): Float32Array;

/**
 * One direction of the duet cross-ring: takes a producing agent's TTS PCM,
 * resamples 24 kHz → 16 kHz, and forwards each chunk to the consumer's mic.
 */
export class DuetSink {
  constructor(
    onResampled: (pcm: Float32Array, sampleRate: number) => void,
    opts?: { targetRate?: number; sourceRate?: number },
  );
  onResampled: (pcm: Float32Array, sampleRate: number) => void;
  targetRate: number;
  sourceRate: number;
  write(pcm: Float32Array, sampleRate?: number): void;
  drain(): void;
  bufferedSamples(): number;
  /** Total INPUT samples written to this sink (at the source rate). */
  totalWritten(): number;
  /** Total OUTPUT samples forwarded (at `targetRate`). */
  totalForwarded(): number;
  /** `Date.now()` of the most recent `write()`, or 0 if none. */
  lastWriteAt(): number;
  /** Seconds of audio (at the source rate) forwarded so far. */
  forwardedSeconds(): number;
}

/**
 * The duet's two cross-rings: `aToB` carries agent A's speech into agent B's
 * ear; `bToA` carries B's reply back to A.
 */
export class DuetAudioBridge {
  constructor(args: {
    micSourceA: { push(pcm: Float32Array): void };
    micSourceB: { push(pcm: Float32Array): void };
    opts?: {
      ringMs?: number;
      targetRate?: number;
      onForward?: (dir: "aToB" | "bToA", pcm: Float32Array) => void;
    };
  });
  ringMs: number;
  aToB: DuetSink;
  bToA: DuetSink;
  /** The sink the harness assigns to engine A's scheduler. */
  sinkForA(): DuetSink;
  /** The sink the harness assigns to engine B's scheduler. */
  sinkForB(): DuetSink;
}
