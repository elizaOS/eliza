/**
 * Test-only `ElizaInferenceFfi` stand-in. Only the methods the voice
 * pipeline exercises are non-trivial: `asrTranscribe` returns the supplied
 * fixed transcript; `ttsSynthesize` writes a constant number of samples;
 * `ttsSynthesizeStream` emits the same PCM as two chunks (one body + one
 * `isFinal` tail) and honours `onChunk` returning `true` as a cancel.
 * The ABI-v2 streaming-ASR symbols report "no working decoder" by
 * default (the same as the C stub) so the pipeline routes through the v1
 * batch path unless a test opts into `asrStreamSupported`. Everything
 * else is a no-op / identity so a test can wire a "fused" FFI without a
 * real `.dylib`.
 */
import type { ElizaInferenceFfi, TtsStreamChunk } from "../ffi-bindings";

export function fakeFfi(
  transcript: string,
  opts: {
    ttsSamples?: number;
    ttsStreamSupported?: boolean;
    asrStreamSupported?: boolean;
    vadSupported?: boolean;
    vadProbs?: readonly number[];
  } = {},
): ElizaInferenceFfi {
  const ttsSamples = opts.ttsSamples ?? 8;
  const ttsStreamSupported = opts.ttsStreamSupported ?? true;
  const asrStreamSupported = opts.asrStreamSupported ?? false;
  const vadSupported = opts.vadSupported ?? false;
  const vadProbs = opts.vadProbs ?? [0];
  let vadIdx = 0;
  return {
    libraryPath: "/fake/libelizainference.so",
    libraryAbiVersion: "2",
    create: () => 1n,
    destroy: () => {},
    mmapAcquire: () => {},
    mmapEvict: () => {},
    ttsSynthesize: ({ out }) => {
      const n = Math.min(ttsSamples, out.length);
      out.fill(0.1, 0, n);
      return n;
    },
    asrTranscribe: () => transcript,
    ttsStreamSupported: () => ttsStreamSupported,
    ttsSynthesizeStream: ({ onChunk }) => {
      const body = new Float32Array(ttsSamples).fill(0.1);
      const wantCancel = onChunk({
        pcm: body,
        isFinal: false,
      } as TtsStreamChunk);
      onChunk({ pcm: new Float32Array(0), isFinal: true });
      return { cancelled: wantCancel === true };
    },
    cancelTts: () => {},
    setVerifierCallback: () => ({ close: () => {} }),
    vadSupported: () => vadSupported,
    vadOpen: () => 2n,
    vadProcess: ({ pcm }) => {
      if (pcm.length !== 512) throw new Error("fake VAD expected 512 samples");
      const p = vadProbs[vadIdx] ?? vadProbs[vadProbs.length - 1] ?? 0;
      vadIdx++;
      return p;
    },
    vadReset: () => {},
    vadClose: () => {},
    asrStreamSupported: () => asrStreamSupported,
    asrStreamOpen: () => 1n,
    asrStreamFeed: () => {},
    asrStreamPartial: () => ({ partial: transcript }),
    asrStreamFinish: () => ({ partial: transcript }),
    asrStreamClose: () => {},
    close: () => {},
  };
}
