/** Public surface of the local voice pipeline: audio ingest, barge-in, cancellation, streaming ASR, phrase scheduling, speaker attribution, and the engine bridge. */
export {
	type AttributedTurn,
	type AttributedTurnListener,
	type AttributionPipelineLike,
	AUDIO_FRAME_PIPELINE_SAMPLE_RATE,
	AudioFrameConsumer,
	type AudioFrameConsumerConfig,
	type AudioFrameConsumerDeps,
	AudioFrameDecodeError,
	type AudioFrameEvent,
	decodeAudioFramePcm,
	type RuntimeEventSink,
	type VadSegmenter,
} from "./audio-frame-consumer";
export {
	BargeInController,
	type BargeInControllerConfig,
	type BargeInListener,
	type CancelSignal,
} from "./barge-in";
export {
	type CoordinatorRuntime,
	VoiceCancellationCoordinator,
	type VoiceCancellationCoordinatorOptions,
} from "./cancellation-coordinator";
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
	computeDiarizationErrorRate,
	type DerOptions,
	type DerResult,
	type DiarizationSegment,
	diarizationWithinBudget,
} from "./diarization-error-rate";
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
	DEFAULT_PLAYBACK_DELAY_MS,
	type EchoDelayEstimate,
	type EchoDelayOptions,
	estimateEchoDelaySamples,
	PLATFORM_PLAYBACK_DELAY_DEFAULTS,
	platformPlaybackDelayMs,
	platformPlaybackDelaySamples,
} from "./echo-delay";
export {
	type AecCaptureReplayInput,
	type AecCaptureReplayResult,
	computeErle,
	computeFarActiveErle,
	replayAecCaptureErle,
} from "./echo-metrics";
export {
	EchoReferenceBuffer,
	type EchoReferenceBufferOptions,
} from "./echo-reference-buffer";
export type {
	LlamaContextLike as Eliza1EotLlamaContext,
	LlamaContextSequenceLike as Eliza1EotLlamaSequence,
	LlamaModelLike as Eliza1EotLlamaModel,
} from "./eliza1-eot-scorer";
export {
	Eliza1EotScorer,
	formatEotPrompt as formatEliza1EotPrompt,
} from "./eliza1-eot-scorer";
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
	StubTtsBackend,
	type VoiceTurnEvents,
} from "./engine-bridge";
export {
	Eliza1EotClassifier,
	type Eliza1EotScoreResult,
	type Eliza1EotScorerOptions,
	EOT_COMMIT_SILENCE_MS,
	EOT_COMMIT_THRESHOLD,
	EOT_HANGOVER_EXTENSION_MS,
	EOT_MID_CLAUSE_THRESHOLD,
	EOT_TENTATIVE_SILENCE_MS,
	EOT_TENTATIVE_THRESHOLD,
	type EotClassifier,
	HeuristicEotClassifier,
	LIVEKIT_TURN_DETECTOR_EN_REVISION,
	LIVEKIT_TURN_DETECTOR_INTL_REVISION,
	RemoteEotClassifier,
	type RemoteEotClassifierOptions,
	turnDetectorRevisionForTier,
	turnSignalFromProbability,
	type VoiceNextSpeaker,
	type VoiceTurnSignal,
} from "./eot-classifier";
export {
	applyGemmaUserTemplate,
	createBundledLiveKitGgmlTurnDetector,
	DEFAULT_LIVEKIT_TURN_DETECTOR_GGML_DIR,
	DEFAULT_LIVEKIT_TURN_DETECTOR_GGUF_EN,
	DEFAULT_LIVEKIT_TURN_DETECTOR_GGUF_INTL,
	EotGgmlUnavailableError,
	LIVEKIT_END_OF_TURN_TOKEN,
	LiveKitGgmlTurnDetector,
	type LiveKitGgmlTurnDetectorOptions,
	turnDetectorGgufForTier,
} from "./eot-classifier-ggml";
export { VoiceStartupError } from "./errors";
export {
	cancelEchoInWavUtterance,
	type DesktopAecPassthroughReason,
	type DesktopAecResult,
	type DesktopAecUtteranceSummary,
	FarEndReference,
	type FarEndReferenceStatus,
	getSharedFarEndReference,
} from "./far-end-reference";
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
	bridgeDetectorToFusedWake,
	type FusedWakeEventDetail,
	type FusedWakeSink,
	type FusedWakeStage,
} from "./fused-wake-bridge";
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
	NlmsEchoCanceller,
	type NlmsEchoCancellerOptions,
} from "./nlms-echo-canceller";
export {
	DEFAULT_OPTIMISTIC_EOT_THRESHOLD,
	OptimisticGenerationPolicy,
	type OptimisticPolicyOptions,
	type PowerSourceState,
	type ResolveOptimisticPolicyArgs,
	resolveOptimisticPolicyEnabled,
	resolvePowerSourceState,
} from "./optimistic-policy";
export {
	createDefaultPhonemeTokenizer,
	type Phoneme,
	type PhonemeTokenizer,
	RuleBasedEnglishPhonemeTokenizer,
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
	MissingAsrTranscriber,
	MtpDraftProposer,
	MtpTargetVerifier,
	type MtpTextRunner,
	mtpTextRunner,
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
	AGENT_SELF_VOICE_IMPRINT_THRESHOLD,
	AgentSelfVoiceImprint,
	type AgentSelfVoiceImprintOptions,
	type AgentSelfVoiceImprintSource,
	getAgentSelfVoiceImprint,
	registerAgentSelfVoiceImprint,
} from "./self-voice-imprint";
export {
	createMtpDraftHandle,
	type KernelSet,
	type MmapRegionHandle,
	type MtpDraftHandle,
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
	type PyannoteDiarizerModelId,
} from "./speaker/diarizer";
export {
	FusedDiarizer,
	type FusedDiarizerOptions,
} from "./speaker/diarizer-fused";
export {
	averageEmbeddings,
	type SpeakerEncoder,
	SpeakerEncoderUnavailableError,
	WESPEAKER_EMBEDDING_DIM,
	WESPEAKER_MIN_SAMPLES,
	WESPEAKER_RESNET34_LM_FP32_MODEL_ID,
	WESPEAKER_RESNET34_LM_INT8_MODEL_ID,
	WESPEAKER_SAMPLE_RATE,
	type WespeakerModelId,
} from "./speaker/encoder";
export {
	FusedSpeakerEncoder,
	type FusedSpeakerEncoderOptions,
} from "./speaker/encoder-fused";
export {
	SPEAKER_GGML_EMBEDDING_DIM,
	SPEAKER_GGML_MIN_SAMPLES,
	SPEAKER_GGML_SAMPLE_RATE,
	SpeakerEncoderGgmlUnavailableError,
	voiceSpeakerDistance,
} from "./speaker/encoder-ggml";
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
	LocalAgreementBuffer,
	type PickStreamingModeArgs,
	pickStreamingMode,
	readStreamingAsrEnabledFromEnv,
	StabilizedStreamingTranscriber,
	StreamingAsrFeeder,
	type StreamingAsrFeederEvents,
	type StreamingPipelineMode,
	WordAgreementGate,
} from "./streaming-asr/streaming-pipeline-adapter";
export {
	SystemAudioSink,
	type SystemAudioSinkOptions,
	WavFileAudioSink,
	type WavFileAudioSinkOptions,
} from "./system-audio-sink";
export {
	ASR_SAMPLE_RATE,
	type AsrDecodePassStats,
	AsrUnavailableError,
	BaseStreamingTranscriber,
	type CreateStreamingTranscriberOptions,
	createStreamingTranscriber,
	DEFAULT_ASR_STEP_SECONDS,
	FfiBatchTranscriber,
	type FfiBatchTranscriberOptions,
	FfiStreamingTranscriber,
	ffiSupportsStreamingAsr,
	readAsrStepSecondsFromEnv,
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
	END_HANGOVER_FIXED_VAD_MS,
	END_HANGOVER_SEMANTIC_EOT_MS,
	type ExternalVadAdapter,
	GgmlSileroVad,
	NativeSileroVad,
	type ResolvedVadProvider,
	RmsEnergyGate,
	type RmsEnergyGateConfig,
	resolveSileroVadPath,
	resolveVadProvider,
	rms,
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
	ensureSharedVoiceBudget,
	FUSED_EOT_SCORER_RESERVE_BYTES,
	KOKORO_TTS_TRANSIENT_PEAK_BYTES,
	OMNIVOICE_TTS_TRANSIENT_PEAK_BYTES,
	pickVoiceTierSlot,
	priorityClassForRole,
	type ReservationSnapshot,
	reserveOrRamPressure,
	setSharedVoiceBudgetForTest,
	VAD_RESERVE_BYTES,
	VOICE_ENSEMBLE_BUDGETS,
	type VoiceBudget,
	type VoiceBundleFitDecision,
	type VoiceEnsembleBudget,
	type VoiceTierSlot,
	voiceEnsemblePeakMb,
	voiceEnsembleSteadyStateMb,
	WAKE_WORD_RESERVE_BYTES,
} from "./voice-budget";
export {
	type ArbiterPreloader,
	VoicePreloadPredictor,
	type VoicePreloadPredictorOptions,
} from "./voice-preload-predictor";
export {
	readVoicePresetFile,
	VOICE_PRESET_MAGIC,
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
	GgmlWakeWordModel,
	isPlaceholderWakeWordHead,
	loadBundledWakeWordModel,
	OPENWAKEWORD_DEFAULT_HEAD,
	OPENWAKEWORD_DIR_REL_PATH,
	OPENWAKEWORD_GGUF_REL_PATH,
	OPENWAKEWORD_PLACEHOLDER_HEADS,
	OpenWakeWordDetector,
	resolveWakeWordModel,
	type WakeFireInfo,
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
 *      - the MTP drafter (always wired — see AGENTS.md §3 #4)
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
