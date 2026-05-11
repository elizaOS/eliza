/**
 * Test-only `ElizaInferenceFfi` stand-in. Only the methods the voice
 * pipeline exercises are non-trivial: `asrTranscribe` returns the supplied
 * fixed transcript; `ttsSynthesize` writes a constant number of samples.
 * The ABI-v2 streaming-ASR symbols report "no working decoder" (the same
 * as the C stub) so the pipeline routes through the v1 batch path.
 * Everything else is a no-op / identity so a test can wire a "fused" FFI
 * without a real `.dylib`.
 */
import type { ElizaInferenceFfi } from "../ffi-bindings";

export function fakeFfi(
  transcript: string,
  opts: { ttsSamples?: number } = {},
): ElizaInferenceFfi {
  const ttsSamples = opts.ttsSamples ?? 8;
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
    asrStreamSupported: () => false,
    asrStreamOpen: () => 0n,
    asrStreamFeed: () => {},
    asrStreamPartial: () => ({ partial: "" }),
    asrStreamFinish: () => ({ partial: "" }),
    asrStreamClose: () => {},
    close: () => {},
  };
}
