export {
  BargeInController,
  type BargeInControllerConfig,
  type BargeInListener,
  type CancelSignal,
} from "./barge-in";
export {
  buildLocalEmbeddingRoute,
  EMBEDDING_DIR_REL_PATH,
  EMBEDDING_FULL_DIM,
  EMBEDDING_MATRYOSHKA_DIMS,
  isValidEmbeddingDim,
  type LocalEmbeddingRoute,
  type LocalEmbeddingSource,
  POOLED_TEXT_EMBEDDING_TIERS,
  resolveLocalEmbeddingSource,
  truncateMatryoshka,
} from "./embedding";
export {
  EmbeddingServer,
  embeddingServerForRoute,
} from "./embedding-server";
export {
  decodeMonoPcm16Wav,
  defaultLifecycleLoaders,
  EngineVoiceBridge,
  type EngineVoiceBridgeOptions,
  encodeMonoPcm16Wav,
  FfiOmniVoiceBackend,
  StubOmniVoiceBackend,
} from "./engine-bridge";
export { VoiceStartupError } from "./errors";
export {
  type ArmedResources,
  type TextResources,
  VoiceLifecycle,
  VoiceLifecycleError,
  type VoiceLifecycleEvents,
  type VoiceLifecycleLoaders,
  type VoiceLifecycleState,
} from "./lifecycle";
export {
  DesktopMicSource,
  type DesktopMicSourceOptions,
  PushMicSource,
  pipeMicToRingBuffer,
} from "./mic-source";
export {
  CharacterPhonemeStub,
  type Phoneme,
  type PhonemeTokenizer,
} from "./phoneme-tokenizer";
export {
  type CachedPhraseAudio,
  canonicalizePhraseText,
  DEFAULT_PHRASE_CACHE_SEED,
  FIRST_AUDIO_FILLERS,
  PhraseCache,
} from "./phrase-cache";
export { chunkTokens, PhraseChunker } from "./phrase-chunker";
export {
  type DraftProposer,
  splitTranscriptToTokens,
  type TargetVerifier,
  VoicePipeline,
  type VoicePipelineConfig,
  type VoicePipelineDeps,
  type VoicePipelineEvents,
} from "./pipeline";
export {
  type DflashTextRunner,
  dflashTextRunner,
  LlamaServerDraftProposer,
  LlamaServerTargetVerifier,
  MissingAsrTranscriber,
} from "./pipeline-impls";
export { InMemoryAudioSink, PcmRingBuffer } from "./ring-buffer";
export { type RollbackEvent, RollbackQueue } from "./rollback-queue";
export {
  type SchedulerDeps,
  type SchedulerEvents,
  VoiceScheduler,
} from "./scheduler";
export {
  createDflashDrafterHandle,
  type DflashDrafterHandle,
  type KernelSet,
  type MmapRegionHandle,
  type RefCountedResource,
  type SchedulerSlot,
  SharedResourceRegistry,
  type SharedTokenizer,
} from "./shared-resources";
export {
  cosineSimilarity,
  DEFAULT_VOICE_IMPRINT_MATCH_THRESHOLD,
  matchVoiceImprint,
  normalizeVoiceEmbedding,
  updateVoiceImprintCentroid,
  type VoiceImprintCentroidUpdate,
  type VoiceImprintMatch,
  type VoiceImprintProfile,
  voiceSpeakerFromImprintMatch,
} from "./speaker-imprint";
export {
  DEFAULT_VOICE_ID,
  DEFAULT_VOICE_PRESET_REL_PATH,
  type LoadedPresetBundle,
  type PresetBundlePaths,
  SpeakerPresetCache,
  type SpeakerPresetCacheOptions,
  voicePresetPath,
} from "./speaker-preset-cache";
export {
  SystemAudioSink,
  type SystemAudioSinkOptions,
  WavFileAudioSink,
  type WavFileAudioSinkOptions,
} from "./system-audio-sink";
export {
  ASR_SAMPLE_RATE,
  AsrUnavailableError,
  BaseStreamingTranscriber,
  type CreateStreamingTranscriberOptions,
  createStreamingTranscriber,
  downloadWhisperModel,
  FfiBatchTranscriber,
  type FfiBatchTranscriberOptions,
  FfiStreamingTranscriber,
  ffiSupportsStreamingAsr,
  makeWhisperCppDecoder,
  parseWhisperStdout,
  resampleLinear,
  resolveWhisperBinary,
  resolveWhisperModelPath,
  type WhisperCppOptions,
  WhisperCppStreamingTranscriber,
  type WhisperDecoder,
  whisperDir,
} from "./transcriber";
export {
  type VoiceGenerateRequest,
  VoiceTurnController,
  type VoiceTurnControllerConfig,
  type VoiceTurnControllerDeps,
  type VoiceTurnControllerEvents,
  type VoiceTurnOutcome,
} from "./turn-controller";
export * from "./types";
export {
  createSileroVadDetector,
  NativeSileroVad,
  RmsEnergyGate,
  type RmsEnergyGateConfig,
  resolveSileroVadPath,
  rms,
  SILERO_VAD_BUNDLE_REL_PATH,
  SileroVad,
  VadDetector,
  type VadDetectorConfig,
  VadUnavailableError,
} from "./vad";
export {
  readVoicePresetFile,
  VOICE_PRESET_HEADER_BYTES,
  VOICE_PRESET_MAGIC,
  VOICE_PRESET_VERSION,
  type VoicePresetFile,
  VoicePresetFormatError,
  type VoicePresetSeedPhrase,
  writeVoicePresetFile,
} from "./voice-preset-format";
export {
  isPlaceholderWakeWordHead,
  loadBundledWakeWordModel,
  OPENWAKEWORD_DEFAULT_HEAD,
  OPENWAKEWORD_DEFAULT_HEAD_REL_PATH,
  OPENWAKEWORD_DIR_REL_PATH,
  OPENWAKEWORD_EMBEDDING_REL_PATH,
  OPENWAKEWORD_MELSPEC_REL_PATH,
  OPENWAKEWORD_PLACEHOLDER_HEADS,
  OpenWakeWordDetector,
  OpenWakeWordModel,
  resolveWakeWordModel,
  type WakeWordConfig,
  type WakeWordModel,
  type WakeWordModelPaths,
  WakeWordUnavailableError,
} from "./wake-word";

/**
 * Voice on/off invariants (binding for every consumer of this module):
 *
 * 1. Voice is OFF by default — text + drafter only. Before
 *    `EngineVoiceBridge.start()` there are no voice resources in RAM.
 *    After `start()` but before `VoiceLifecycle.arm()`, only the tiny
 *    default speaker preset, phrase seed metadata, and scheduler
 *    scaffolding are live. TTS/ASR weight regions are NOT mapped or
 *    re-paged until `VoiceLifecycle.arm()` calls the fused ABI's
 *    `mmap_acquire`.
 *
 * 2. Shared resources between text and voice (one instance each per
 *    engine, refcounted by `SharedResourceRegistry`):
 *      - tokenizer (Eliza-1/OmniVoice share a vocabulary)
 *      - mmap regions for weights (deduplicated by absolute path)
 *      - the fused kernel set (TurboQuant/QJL/Polar live in the
 *        same shipped llama.cpp library after the fusion build)
 *      - the scheduler queue (one queue, prioritised across surfaces)
 *      - the DFlash drafter (always wired — see AGENTS.md §3 #4)
 *
 *    Text and voice keep SEPARATE KV caches (different layer counts,
 *    different head configs, different quantizations — AGENTS.md §4
 *    "shared KV cache scheduling, not shared KV memory").
 *
 * 3. `arm()` lazily loads TTS + ASR via mmap; `disarm()` issues a real
 *    page-eviction call (`madvise(MADV_DONTNEED)` on Linux/Android,
 *    `madvise(MADV_FREE_REUSABLE)` on Apple, `VirtualUnlock` +
 *    `OfferVirtualMemory` on Windows). The speaker preset and phrase
 *    cache stay in a small LRU after disarm — they're KB-scale.
 *
 * 4. Hardware-resource exhaustion (RAM pressure, OS page eviction
 *    refusal, mmap fail, kernel missing) MUST surface as a
 *    `VoiceLifecycleError` with a structured `code`. There is NO
 *    silent fallback to text-only and NO automatic downgrade to a
 *    smaller voice model — see AGENTS.md §3.
 *
 * 5. Illegal lifecycle transitions throw `VoiceLifecycleError` with
 *    code `"illegal-transition"`. The state is a discriminated
 *    union, never a string.
 */
