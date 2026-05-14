export {
	BargeInController,
	type BargeInControllerConfig,
	type BargeInListener,
	type CancelSignal,
} from "./barge-in";
export {
	type CheckpointHandle,
	CheckpointHandleInvalidError,
	CheckpointManager,
	type CheckpointManagerLike,
	type CheckpointManagerOptions,
	MockCheckpointManager,
	type MockCheckpointSnapshot,
	type MockSnapshotSource,
} from "./checkpoint-manager";
export {
	type BuildDeterministicFn,
	type BuildMessageDependentFn,
	type ContextPartial,
	EagerContextBuilder,
	type EagerContextBuilderOptions,
	type FullContext,
	mergeContext,
} from "./eager-context-builder";
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
	attributeVoiceEmotion,
	type VoiceEmotionAsrFeatures,
	type VoiceEmotionAttribution,
	type VoiceEmotionAttributionInput,
	type VoiceEmotionAttributionMethod,
	type VoiceEmotionAudioFeatures,
	type VoiceEmotionEvidence,
} from "./emotion-attribution";
export {
	decodeMonoPcm16Wav,
	defaultLifecycleLoaders,
	EngineVoiceBridge,
	type EngineVoiceBridgeOptions,
	encodeMonoPcm16Wav,
	FfiOmniVoiceBackend,
	StubOmniVoiceBackend,
} from "./engine-bridge";
export {
	createBundledLiveKitTurnDetector,
	createBundledTurnsenseEotClassifier,
	DEFAULT_LIVEKIT_TURN_DETECTOR_DIR,
	DEFAULT_LIVEKIT_TURN_DETECTOR_ONNX,
	DEFAULT_TURNSENSE_DIR,
	DEFAULT_TURNSENSE_ONNX,
	EOT_COMMIT_SILENCE_MS,
	EOT_COMMIT_THRESHOLD,
	EOT_HANGOVER_EXTENSION_MS,
	EOT_MID_CLAUSE_THRESHOLD,
	EOT_TENTATIVE_SILENCE_MS,
	EOT_TENTATIVE_THRESHOLD,
	type EotClassifier,
	HeuristicEotClassifier,
	LEGACY_LIVEKIT_TURN_DETECTOR_ONNX,
	LIVEKIT_TURN_DETECTOR_EN_REVISION,
	LIVEKIT_TURN_DETECTOR_HF_REPO,
	LIVEKIT_TURN_DETECTOR_INTL_REVISION,
	LiveKitTurnDetector,
	type LiveKitTurnDetectorOptions,
	RemoteEotClassifier,
	type RemoteEotClassifierOptions,
	TURNSENSE_HF_REPO,
	TurnsenseEotClassifier,
	type TurnsenseEotClassifierOptions,
	turnDetectorRevisionForTier,
	turnSignalFromProbability,
	type VoiceNextSpeaker,
	type VoiceTurnSignal,
} from "./eot-classifier";
export { VoiceStartupError } from "./errors";
export * from "./ffi-bindings";
export {
	_resetSharedFirstLineCacheForTesting,
	_resetVoiceRevisionMemoForTesting,
	computeLocalVoiceRevision,
	FIRST_SENTENCE_MAX_WORDS,
	FIRST_SENTENCE_SNIP_VERSION,
	FirstLineCache,
	type FirstLineCacheEntry,
	type FirstLineCacheKey,
	type FirstLineCacheOptions,
	type FirstLineCacheStats,
	type FirstSentenceSnipResult,
	fingerprintVoiceSettings,
	firstLineCacheBypassFromEnv,
	firstSentenceSnip,
	getSharedFirstLineCache,
	hashCacheKey,
	type PutInput,
	wordCount,
} from "./first-line-cache";
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
	resolveDesktopRecorder,
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
export {
	type PrefillOptimisticArgs,
	type PrefillOptimisticOptions,
	type PrefillOptimisticResult,
	prefillOptimistic,
} from "./prefill-client";
export {
	PrefixPreservingQueue,
	type RollbackResult,
	type TaggedAudioChunk,
} from "./prefix-preserving-queue";
export {
	isOutlier,
	VOICE_PROFILE_RECORD_SCHEMA_VERSION,
	type VoiceImprintMatchHandle,
	type VoiceProfileAudioRef,
	type VoiceProfileConsentState,
	type VoiceProfileObservation,
	type VoiceProfileRecord,
	VoiceProfileStore,
	type VoiceProfileStoreOptions,
	welfordUpdate,
	welfordVariance,
} from "./profile-store";
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
	type VoiceAttributionOutput,
	VoiceAttributionPipeline,
	type VoiceAttributionPipelineDeps,
	type VoiceAttributionRequest,
} from "./speaker/attribution-pipeline";
export {
	classifyFramesToSegments,
	type Diarizer,
	type DiarizerOutput,
	DiarizerUnavailableError,
	type LocalSpeakerSegment,
	PYANNOTE_CLASS_COUNT,
	PYANNOTE_CLASS_TO_SPEAKERS,
	PYANNOTE_FRAME_STRIDE_MS,
	PYANNOTE_FRAMES_PER_WINDOW,
	PYANNOTE_SAMPLE_RATE,
	PYANNOTE_SEGMENTATION_3_FP32_MODEL_ID,
	PYANNOTE_SEGMENTATION_3_INT8_MODEL_ID,
	PYANNOTE_WINDOW_SECONDS,
	PyannoteDiarizer,
	type PyannoteDiarizerModelId,
} from "./speaker/diarizer";
export {
	averageEmbeddings,
	type SpeakerEncoder,
	SpeakerEncoderUnavailableError,
	WESPEAKER_EMBEDDING_DIM,
	WESPEAKER_MIN_SAMPLES,
	WESPEAKER_RESNET34_LM_FP32_MODEL_ID,
	WESPEAKER_RESNET34_LM_INT8_MODEL_ID,
	WESPEAKER_SAMPLE_RATE,
	WespeakerEncoder,
	type WespeakerModelId,
} from "./speaker/encoder";
export {
	type AttributedVoiceObservation,
	attributeVoiceImprintObservations,
	cosineSimilarity,
	DEFAULT_VOICE_IMPRINT_MATCH_THRESHOLD,
	matchVoiceImprint,
	normalizeVoiceEmbedding,
	type SpeakerAttributionResult,
	updateVoiceImprintCentroid,
	type VoiceImprintCentroidUpdate,
	type VoiceImprintMatch,
	type VoiceImprintObservationInput,
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
	FfiBatchTranscriber,
	type FfiBatchTranscriberOptions,
	FfiStreamingTranscriber,
	ffiSupportsStreamingAsr,
	resampleLinear,
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
	createVadDetector,
	NativeSileroVad,
	type QwenToolkitVadAdapter,
	type ResolvedVadProvider,
	RmsEnergyGate,
	type RmsEnergyGateConfig,
	resolveSileroVadPath,
	resolveVadProvider,
	rms,
	SILERO_VAD_BUNDLE_REL_PATH,
	SileroVad,
	VadDetector,
	type VadDetectorConfig,
	type VadLike,
	type VadProviderId,
	type VadProviderPreference,
	VadUnavailableError,
	vadProviderOrder,
} from "./vad";
export {
	type AllocationPriority,
	assessVoiceBundleFits,
	BudgetExhaustedError,
	type BudgetReservation,
	createVoiceBudget,
	createVoiceBudgetForTest,
	DEFAULT_VOICE_BUNDLE_RESERVE_MB,
	pickVoiceTierSlot,
	priorityClassForRole,
	type ReservationSnapshot,
	VOICE_ENSEMBLE_BUDGETS,
	type VoiceBudget,
	type VoiceBundleFitDecision,
	type VoiceEnsembleBudget,
	type VoiceTierSlot,
	voiceEnsemblePeakMb,
	voiceEnsembleSteadyStateMb,
} from "./voice-budget";
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
	analyzeVoiceProfileWav,
	canonicalVoiceProfileJson,
	createVoiceProfileArtifact,
	VOICE_PROFILE_ARTIFACT_SCHEMA_VERSION,
	VOICE_PROFILE_FEATURE_EMBEDDING_MODEL,
	type VoiceProfileArtifact,
	type VoiceProfileArtifactSample,
	type VoiceProfileArtifactStatus,
	type VoiceProfileArtifactVerification,
	type VoiceProfileAudioFeatures,
	type VoiceProfileConsent,
	type VoiceProfileReferenceMetadata,
	type VoiceProfileSampleInput,
	verifyVoiceProfileArtifact,
} from "./voice-profile-artifact";
export {
	DEFAULT_VOICE_SETTINGS,
	effectiveBackendMode,
	qualityPresetQuantizationRanking,
	resolveVoiceSettings,
	type VoiceBackendMode,
	type VoiceModelQualityPreset,
	type VoiceSettings,
} from "./voice-settings";
export {
	type DrafterAbortReason,
	type DrafterHandle,
	type StartDrafterFn,
	type VoiceState,
	type VoiceStateEvent,
	VoiceStateMachine,
	type VoiceStateMachineEvents,
	type VoiceStateMachineOptions,
} from "./voice-state-machine";
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
export {
	type TtsBytes,
	type TtsHandler,
	type TtsHandlerInput,
	type TtsHandlerOutput,
	type TtsResolvedContext,
	type WrapOptions,
	wrapWithFirstLineCache,
} from "./wrap-with-first-line-cache";

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
