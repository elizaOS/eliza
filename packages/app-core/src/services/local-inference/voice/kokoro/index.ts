/**
 * Public barrel for the Kokoro-82M TTS adapter.
 *
 * External callers (the engine layer, the bench harness, tests) should
 * import from `./kokoro` rather than reaching into individual files. The
 * internal layout may change; this surface is stable.
 */

export { KokoroTtsBackend } from "./kokoro-backend";
export type { KokoroTtsBackendDeps } from "./kokoro-backend";

export {
  KOKORO_GGUF_REL_PATH,
  KOKORO_ONNX_MODEL_URL,
  KOKORO_VOICES_BASE_URL,
  KokoroGgufRuntime,
  KokoroMockRuntime,
  KokoroOnnxRuntime,
  KokoroPythonRuntime,
} from "./kokoro-runtime";
export type {
  KokoroGgufRuntimeOptions,
  KokoroMockRuntimeOptions,
  KokoroOnnxRuntimeOptions,
  KokoroPythonRuntimeOptions,
  KokoroRuntime,
  KokoroRuntimeChunk,
  KokoroRuntimeInputs,
} from "./kokoro-runtime";

export {
  FallbackG2PPhonemizer,
  KOKORO_PAD_ID,
  NpmPhonemizePhonemizer,
  resolvePhonemizer,
} from "./phonemizer";

export {
  phonemizePhrase,
  streamPhonemes,
} from "./phoneme-stream";
export type {
  PhonemeStreamWindow,
  StreamPhonemesOptions,
} from "./phoneme-stream";

export {
  KokoroModelMissingError,
  KokoroPhonemizerError,
} from "./types";
export type {
  KokoroBackendOptions,
  KokoroModelLayout,
  KokoroPhonemeSequence,
  KokoroPhonemizer,
  KokoroVoiceId,
  KokoroVoicePack,
} from "./types";

export {
  findKokoroVoice,
  KOKORO_DEFAULT_VOICE_ID,
  KOKORO_VOICE_PACKS,
  listKokoroVoiceIds,
  listKokoroVoicesByLang,
  listKokoroVoicesByTag,
  resolveKokoroVoiceOrDefault,
} from "./voices";

export {
  readVoiceBackendModeFromEnv,
  selectVoiceBackend,
} from "./runtime-selection";
export type {
  VoiceBackendChoice,
  VoiceBackendDecision,
  VoiceBackendInputs,
  VoiceBackendMode,
} from "./runtime-selection";
