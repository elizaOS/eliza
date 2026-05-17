/** Same predicate as `ttsDebug` — use to attach optional debug headers / task metadata. */
export declare function isTtsDebugEnabled(): boolean;
/**
 * Single-line preview of text for TTS debug logs (avoids huge console lines).
 * Enable `ELIZA_TTS_DEBUG` only when you accept that spoken lines may appear in logs.
 */
export declare function ttsDebugTextPreview(
  text: string,
  maxChars?: number,
): string;
export declare function ttsDebug(
  phase: string,
  detail?: Record<string, unknown>,
): void;
//# sourceMappingURL=tts-debug.d.ts.map
