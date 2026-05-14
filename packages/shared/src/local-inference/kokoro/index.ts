/**
 * Public barrel for the Kokoro-82M TTS adapter.
 *
 * External callers (the engine layer, the bench harness, tests) should
 * import from `./kokoro` rather than reaching into individual files. The
 * internal layout may change; this surface is stable.
 */

export type { KokoroTtsBackendDeps } from "./kokoro-backend.js";
export { KokoroTtsBackend } from "./kokoro-backend.js";
export type { KokoroEngineDiscoveryResult } from "./kokoro-engine-discovery.js";
export {
  isKokoroGgufFile,
  KOKORO_DEFAULT_SAMPLE_RATE,
  kokoroEngineModelDir,
  resolveKokoroEngineConfig,
} from "./kokoro-engine-discovery.js";
export type {
  KokoroGgufRuntimeOptions,
  KokoroMockRuntimeOptions,
  KokoroOnnxRuntimeOptions,
  KokoroPythonRuntimeOptions,
  KokoroRuntime,
  KokoroRuntimeChunk,
  KokoroRuntimeInputs,
} from "./kokoro-runtime.js";
export {
  KOKORO_GGUF_REL_PATH,
  KOKORO_ONNX_MODEL_URL,
  KOKORO_VOICES_BASE_URL,
  KokoroGgufRuntime,
  KokoroMockRuntime,
  KokoroOnnxRuntime,
  KokoroPythonRuntime,
} from "./kokoro-runtime.js";
export type {
  PhonemeStreamWindow,
  StreamPhonemesOptions,
} from "./phoneme-stream.js";
export {
  phonemizePhrase,
  streamPhonemes,
} from "./phoneme-stream.js";
export {
  FallbackG2PPhonemizer,
  KOKORO_PAD_ID,
  NpmPhonemizePhonemizer,
  resolvePhonemizer,
} from "./phonemizer.js";
export type {
  VoiceBackendChoice,
  VoiceBackendDecision,
  VoiceBackendInputs,
  VoiceBackendMode,
} from "./runtime-selection.js";
export {
  readVoiceBackendModeFromEnv,
  selectVoiceBackend,
} from "./runtime-selection.js";
export type {
  KokoroBackendOptions,
  KokoroModelLayout,
  KokoroPhonemeSequence,
  KokoroPhonemizer,
  KokoroVoiceId,
  KokoroVoicePack,
} from "./types.js";
export {
  KokoroModelMissingError,
  KokoroPhonemizerError,
} from "./types.js";
export type {
  AudioChunk,
  OmniVoiceBackend,
  Phrase,
  SpeakerPreset,
  StreamingTtsBackend,
  TtsPcmChunk,
} from "./voice-types.js";
export {
  findKokoroVoice,
  KOKORO_DEFAULT_VOICE_ID,
  KOKORO_VOICE_PACKS,
  listKokoroVoiceIds,
  listKokoroVoicesByLang,
  listKokoroVoicesByTag,
  resolveKokoroVoiceOrDefault,
} from "./voices.js";
