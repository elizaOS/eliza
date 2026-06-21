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
	type VoiceScenario,
	type VoiceScenarioAssertions,
	type VoiceScenarioClass,
	type VoiceScenarioParticipant,
	type VoiceScenarioTurn,
	type VoiceScenarioValidation,
	turnReferenceTranscript,
	turnSpeakerLabel,
	validateVoiceScenario,
} from "./services/voice/voice-scenario";

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
	type RunVoiceScenarioHeadlessArgs,
	type RunVoiceWorkbenchArgs,
	runVoiceScenarioHeadless,
	runVoiceWorkbenchHeadless,
	type VoiceTurnObservation,
	type VoiceWorkbenchServices,
} from "./services/voice/workbench-headless-runner";

export {
	buildVoiceWorkbenchReport,
	formatVoiceWorkbenchMarkdown,
	type MetricRollup,
	regressionsAgainstBaseline,
	type VoiceWorkbenchMetrics,
	type VoiceWorkbenchReport,
	type VoiceWorkbenchScenarioReport,
	type VoiceWorkbenchScenarioRun,
	type VoiceWorkbenchStatus,
	type VoiceWorkbenchVerdict,
} from "./services/voice/voice-workbench-report";

export {
	buildAndRunVoiceWorkbench,
	type BuildAndRunVoiceWorkbenchArgs,
	type VoiceWorkbenchArtifacts,
	type VoiceWorkbenchResult,
	writeVoiceWorkbenchResult,
} from "./services/voice/workbench-entrypoint";

export {
	groundTruthMockServices,
	VOICE_WORKBENCH_SCENARIOS,
} from "./services/voice/workbench-scenarios";
