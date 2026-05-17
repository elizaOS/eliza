/**
 * TTS-handler ↔ first-line-cache wiring for the app-core runtime.
 *
 * The first-line cache lives in `@elizaos/plugin-local-inference/services`
 * because it needs `node:sqlite` + the local state-dir. We do a dynamic
 * import here so this module stays browser-safe and so cores that don't
 * ship the local-inference plugin still load.
 *
 * Each TTS provider has a different shape for `voiceId`, `voiceRevision`,
 * and voice-settings fingerprint — and they get bundled lazily, so we
 * resolve the context inside the handler closure rather than at registration
 * time.
 */
import type { AgentRuntime } from "@elizaos/core";
/**
 * Loose handler shape that matches both the runtime's generic registerModel
 * signature and `@elizaos/plugin-edge-tts`'s TTS handler. The wrapper passes
 * the input through unchanged, so structural compatibility is what matters.
 */
export type EdgeTtsHandler = (
  runtime: AgentRuntime,
  input: unknown,
) => Promise<unknown>;
/**
 * Wrap an `@elizaos/plugin-edge-tts` `ModelType.TEXT_TO_SPEECH` handler with
 * the local first-line cache.
 *
 * Returns `null` if the cache plugin isn't available (e.g. browser bundle,
 * missing node:sqlite); callers should fall back to the unwrapped handler.
 */
export declare function wrapEdgeTtsHandlerWithFirstLineCache(
  inner: EdgeTtsHandler,
): Promise<EdgeTtsHandler | null>;
//# sourceMappingURL=tts-cache-wiring.d.ts.map
