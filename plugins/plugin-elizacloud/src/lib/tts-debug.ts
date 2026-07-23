/**
 * TTS debug logging. Implementation lives in `@elizaos/shared`
 * (`packages/shared/src/utils/tts-debug.ts`), which emits through the
 * structured logger whenever `ELIZA_TTS_DEBUG` is set (#16347).
 */
export { isTtsDebugEnabled, ttsDebug, ttsDebugTextPreview } from "@elizaos/shared";
