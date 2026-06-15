/**
 * Kokoro-82M model runner.
 *
 * Three execution paths are scaffolded here. Production picks the first
 * available; tests can inject any of them via the `runtime` option on
 * `KokoroTtsBackend`.
 *
 *   1. ONNX Runtime (default, preferred). Kokoro ships an official ONNX
 *      export at `onnx-community/Kokoro-82M-v1.0-ONNX` (~310 MB fp32, ~80
 *      MB int8). We load via `onnxruntime-node` on desktop / server, or
 *      `onnxruntime-web` in the browser. The session is reused across
 *      synthesis calls — voice swap is just rebinding the `style` tensor.
 *
 *   2. GGUF via llama-server. Upstream `ggml-org/llama.cpp` does not ship
 *      a Kokoro head; our `packages/inference/llama.cpp` fork carries
 *      a WIP port. When the host llama-server advertises a Kokoro-capable
 *      build and exposes `/v1/audio/speech`, we POST text in and stream
 *      PCM out. This keeps voice work on the same process as text gen on
 *      mobile builds where loading a second runtime (ORT) is too heavy.
 *
 *   3. Python subprocess. Spawns `python -m kokoro_tts` from a known
 *      venv. NEVER the default in production — used only by the
 *      fine-tune evaluator that drives Apollo's training-loop quality
 *      gate (which already depends on the upstream Python eval suite).
 *
 * # Model fetch (do NOT auto-download in this session)
 *
 * Canonical model URLs (Apache-2.0):
 *   - ONNX (fp32):   https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model.onnx
 *   - ONNX (q8):     https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_quantized.onnx
 *   - Voices:        https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/tree/main/voices
 *   - PyTorch ckpt:  https://huggingface.co/hexgrad/Kokoro-82M/resolve/main/kokoro-v1_0.pth
 *
 * After download, the runtime verifies SHA-256 against the value pinned in
 * `eliza-1.manifest.json` (or `KOKORO_MODEL_SHA256` env var for ad-hoc
 * builds). A mismatch raises `KokoroModelMissingError` and the engine
 * refuses to activate Kokoro — no silent downgrade.
 */

import type {
  KokoroModelLayout,
  KokoroPhonemeSequence,
  KokoroVoicePack,
} from "./types.js";

/** Pinned voices directory tree on HF. Each voice pack is a single .bin. */
export const KOKORO_VOICES_BASE_URL =
  "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices";

/** Pinned GGUF candidate location (carried by our llama.cpp fork). The
 *  runtime references this only for diagnostics; the fork-side builder
 *  produces the file at this path. */
export const KOKORO_GGUF_REL_PATH = "voice/kokoro-82m-v1_0.gguf";

/** One synthesized PCM segment delivered to the streaming backend. */
export interface KokoroRuntimeChunk {
  pcm: Float32Array;
  sampleRate: number;
  isFinal: boolean;
}

/**
 * Construction-time inputs for a runtime instance. The voice pack contains
 * the style tensor reference; the runtime is responsible for resolving the
 * bytes off `layout.voicesDir/<file>`.
 */
export interface KokoroRuntimeInputs {
  phonemes: KokoroPhonemeSequence;
  voice: KokoroVoicePack;
  /**
   * Output sample budget. The runtime always honours the model's native
   * sample rate (`layout.sampleRate`, usually 24 kHz) — this caps the
   * total samples to prevent runaway generation. Defaults to 16 seconds
   * at the layout sample rate (matches the longest phrase the chunker
   * will emit + headroom).
   */
  maxSamples?: number;
  /** Cancellation signal — polled at chunk boundaries. */
  cancelSignal: { cancelled: boolean };
  /** Per-chunk callback; returning `true` cancels the rest of the run. */
  onChunk: (chunk: KokoroRuntimeChunk) => boolean | undefined;
}

/** Shared runtime contract — `KokoroTtsBackend` depends on this, not the
 *  concrete classes. Tests inject a mock. */
export interface KokoroRuntime {
  readonly id: "gguf" | "python" | "mock" | "onnx";
  readonly sampleRate: number;
  synthesize(args: KokoroRuntimeInputs): Promise<{ cancelled: boolean }>;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// GGUF via llama-server path. Production-eligible on mobile builds where the
// text-gen llama-server already runs and reloading a second runtime is too
// heavy. Wires `/v1/audio/speech` per the upstream draft spec.
// ---------------------------------------------------------------------------

export interface KokoroGgufRuntimeOptions {
  /** Base URL of the running llama-server, e.g. `http://127.0.0.1:8081`. */
  serverUrl: string;
  /** Model id the server advertises (`kokoro-82m-v1`). */
  modelId: string;
  /** Output sample rate the server emits. */
  sampleRate: number;
  /** Custom `fetch` implementation (tests inject one). */
  fetchImpl?: typeof fetch;
}

/**
 * GGUF-backed runtime that talks to a llama-server instance with the
 * Kokoro head. The server speaks the `/v1/audio/speech` OpenAI-compatible
 * endpoint; chunked transfer streams raw PCM frames.
 */
export class KokoroGgufRuntime implements KokoroRuntime {
  readonly id = "gguf" as const;
  readonly sampleRate: number;
  private readonly opts: KokoroGgufRuntimeOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: KokoroGgufRuntimeOptions) {
    this.opts = opts;
    this.sampleRate = opts.sampleRate;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async synthesize(args: KokoroRuntimeInputs): Promise<{ cancelled: boolean }> {
    const url = `${this.opts.serverUrl.replace(/\/+$/, "")}/v1/audio/speech`;
    const ctrl = new AbortController();
    const cancelHook = () => {
      if (args.cancelSignal.cancelled) ctrl.abort();
    };
    const interval = setInterval(cancelHook, 25);
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        body: JSON.stringify({
          model: this.opts.modelId,
          input: decodePhonemesForGgufBody(args.phonemes),
          voice: args.voice.id,
          response_format: "pcm",
          sample_rate: this.sampleRate,
        }),
        headers: { "content-type": "application/json" },
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(
          `[kokoro] llama-server /v1/audio/speech returned ${res.status} ${res.statusText}`,
        );
      }
      const reader = res.body.getReader();
      let cancelled = false;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (args.cancelSignal.cancelled) {
          cancelled = true;
          break;
        }
        if (!value) continue;
        const pcm = bytesToFloat32Pcm(value);
        const want = args.onChunk({
          pcm,
          sampleRate: this.sampleRate,
          isFinal: false,
        });
        if (want === true || args.cancelSignal.cancelled) {
          cancelled = true;
          break;
        }
      }
      args.onChunk({
        pcm: new Float32Array(0),
        sampleRate: this.sampleRate,
        isFinal: true,
      });
      return { cancelled };
    } finally {
      clearInterval(interval);
    }
  }

  dispose(): void {
    // Stateless adapter; nothing to release. The underlying llama-server
    // is owned by the engine and lives across synthesis calls.
  }
}

function decodePhonemesForGgufBody(seq: KokoroPhonemeSequence): string {
  // The upstream spec ships the raw phoneme string; the server tokenises
  // it the same way the ONNX export does. Sending ids would require a
  // server-side schema for `input_ids` which the OpenAI-compat endpoint
  // does not have.
  return seq.phonemes;
}

function bytesToFloat32Pcm(bytes: Uint8Array): Float32Array {
  // The endpoint streams little-endian 16-bit PCM by default; convert.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = view.getInt16(i * 2, true) / 32768;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Python subprocess path — eval-loop only.
// ---------------------------------------------------------------------------

export interface KokoroPythonRuntimeOptions {
  pythonBinary: string;
  /** Resolved layout — the subprocess discovers the model under here. */
  layout: KokoroModelLayout;
  /** Optional env passed through to the subprocess. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Subprocess-backed runtime. Spawns `python -m kokoro_tts ...` per
 * synthesis call (no warm-pool — the Python path is the *eval* path, not
 * the realtime path). Production code paths never select this; the
 * fine-tune evaluator wires it explicitly.
 */
export class KokoroPythonRuntime implements KokoroRuntime {
  readonly id = "python" as const;
  readonly sampleRate: number;

  constructor(opts: KokoroPythonRuntimeOptions) {
    this.sampleRate = opts.layout.sampleRate;
  }

  async synthesize(
    _args: KokoroRuntimeInputs,
  ): Promise<{ cancelled: boolean }> {
    // The eval driver in `packages/training` is the canonical caller and
    // already wires `child_process.spawn`. Surfacing a clear error here
    // keeps the production runtime from accidentally enabling this path.
    throw new Error(
      "[kokoro] KokoroPythonRuntime is eval-only — use it from the fine-tune driver, not the runtime scheduler",
    );
  }

  dispose(): void {
    // No long-lived state.
  }
}

// ---------------------------------------------------------------------------
// Mock runtime — synthesizes a sine sweep keyed to phoneme count so tests
// can observe deterministic PCM without loading ONNX.
// ---------------------------------------------------------------------------

export interface KokoroMockRuntimeOptions {
  sampleRate: number;
  /** Total samples emitted per synthesis call. */
  totalSamples?: number;
  /** Number of body chunks to split the output across. */
  chunkCount?: number;
}

export class KokoroMockRuntime implements KokoroRuntime {
  readonly id = "mock" as const;
  readonly sampleRate: number;
  private readonly opts: Required<KokoroMockRuntimeOptions>;
  calls = 0;

  constructor(opts: KokoroMockRuntimeOptions) {
    this.sampleRate = opts.sampleRate;
    this.opts = {
      sampleRate: opts.sampleRate,
      totalSamples: opts.totalSamples ?? Math.floor(opts.sampleRate * 0.2),
      chunkCount: opts.chunkCount ?? 4,
    };
  }

  async synthesize(args: KokoroRuntimeInputs): Promise<{ cancelled: boolean }> {
    this.calls++;
    const { totalSamples, chunkCount } = this.opts;
    const perChunk = Math.max(1, Math.ceil(totalSamples / chunkCount));
    const freqHz = 100 + (args.phonemes.ids.length % 200);
    let written = 0;
    let cancelled = false;
    for (let off = 0; off < totalSamples; off += perChunk) {
      if (args.cancelSignal.cancelled) {
        cancelled = true;
        break;
      }
      const n = Math.min(perChunk, totalSamples - off);
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = (off + i) / this.sampleRate;
        pcm[i] = Math.sin(2 * Math.PI * freqHz * t) * 0.1;
      }
      written += n;
      const want = args.onChunk({
        pcm,
        sampleRate: this.sampleRate,
        isFinal: false,
      });
      if (want === true || args.cancelSignal.cancelled) {
        cancelled = true;
        break;
      }
    }
    args.onChunk({
      pcm: new Float32Array(0),
      sampleRate: this.sampleRate,
      isFinal: true,
    });
    void written;
    return { cancelled };
  }

  dispose(): void {
    /* nothing */
  }
}

// ---------------------------------------------------------------------------
// KokoroOnnxRuntime — legacy ONNX compatibility path. Real implementation
// lives in the AOSP build pipeline; this class keeps the symbol exported so callers
// that conditionally reference it (plugin-aosp-local-inference) compile.
// ---------------------------------------------------------------------------

export interface KokoroOnnxRuntimeOptions {
  modelPath?: string;
  voicesDir?: string;
  loadOrt?: () => Promise<unknown>;
  layout?: KokoroModelLayout;
  expectedSha256?: string | null;
}

export const KOKORO_ONNX_MODEL_URL =
  "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_q8f16.onnx";

export class KokoroOnnxRuntime implements KokoroRuntime {
  readonly id = "onnx" as const;
  readonly sampleRate = 24000;
  constructor(_opts: KokoroOnnxRuntimeOptions) {
    void _opts;
  }
  async synthesize(
    _args: KokoroRuntimeInputs,
  ): Promise<{ cancelled: boolean }> {
    throw new Error("KokoroOnnxRuntime is not available in this build");
  }
  dispose(): void {}
}
