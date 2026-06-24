/**
 * Public Voice Workbench surface (#8785).
 *
 * The framework-level pieces other packages consume (the scenario-runner's
 * `voice` turn kind, headful players, CI entrypoints): the scenario schema, the
 * corpus generator, the headless runner + services contract, the shared scorers
 * (via `e2e-harness`), the benchmark report, and the run entrypoint. Kept as a
 * thin re-export barrel so consumers import one stable subpath
 * (`@elizaos/plugin-local-inference/voice-workbench`) instead of deep paths.
 */

export {
	type CorpusGroundTruth,
	type CorpusTtsSynthesizer,
	type CorpusTurnLabel,
	type GeneratedVoiceCorpus,
	type GenerateVoiceCorpusOptions,
	generateVoiceCorpus,
	readVoiceCorpusGroundTruth,
	type VoiceCorpusPaths,
	writeVoiceCorpus,
} from "./services/voice/corpus-generator";
export {
	turnReferenceTranscript,
	turnSpeakerLabel,
	type VoiceScenario,
	type VoiceScenarioAssertions,
	type VoiceScenarioClass,
	type VoiceScenarioParticipant,
	type VoiceScenarioTurn,
	type VoiceScenarioValidation,
	validateVoiceScenario,
} from "./services/voice/voice-scenario";
export {
	buildVoiceWorkbenchReport,
	formatVoiceWorkbenchMarkdown,
	type MetricRollup,
	regressionsAgainstBaseline,
	type VoiceAudioArtifact,
	type VoiceWorkbenchMetrics,
	type VoiceWorkbenchReport,
	type VoiceWorkbenchScenarioReport,
	type VoiceWorkbenchScenarioRun,
	type VoiceWorkbenchStatus,
	type VoiceWorkbenchVerdict,
} from "./services/voice/voice-workbench-report";
export {
	type BuildAndRunVoiceWorkbenchArgs,
	buildAndRunVoiceWorkbench,
	type VoiceWorkbenchArtifacts,
	type VoiceWorkbenchResult,
	writeVoiceWorkbenchResult,
} from "./services/voice/workbench-entrypoint";
export {
	type RunVoiceScenarioHeadlessArgs,
	type RunVoiceWorkbenchArgs,
	runVoiceScenarioHeadless,
	runVoiceWorkbenchHeadless,
	type VoiceAudioCaptureSink,
	type VoiceTurnObservation,
	type VoiceWorkbenchServices,
} from "./services/voice/workbench-headless-runner";
export {
	createRealVoiceWorkbenchRuntimeFromEnv,
	type RealVoiceWorkbenchRuntime,
} from "./services/voice/workbench-real-services";

export {
	groundTruthMockServices,
	VOICE_WORKBENCH_SCENARIOS,
} from "./services/voice/workbench-scenarios";
