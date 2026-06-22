/**
 * Voice Workbench headless runner (#8785).
 *
 * Drives a {@link VoiceScenario} + its generated corpus through the real voice
 * services WITHOUT a browser, scores every turn with the shared scorers
 * (`e2e-harness.ts`), and emits one {@link VoiceWorkbenchScenarioRun} the report
 * layer (`voice-workbench-report.ts`) aggregates. The services are injected
 * through {@link VoiceWorkbenchServices} so:
 *   - a provisioned local backend wires the real ASR / diarization / EOT /
 *     respond / entity / TTS path,
 *   - a mock returns ground-truth-derived observations for the CI plumbing lane,
 *   - and an ABSENT backend (`services === null`) or absent corpus
 *     (`corpus === null`) yields a `skipped` run — never a `pass` (honesty
 *     contract).
 *
 * Pure orchestration: it slices the corpus per turn, asks the services to
 * observe the turn, and maps observations onto scorer inputs. No model loading
 * here, so it is unit-testable with a fake services adapter.
 */

import type { CorpusTurnLabel, GeneratedVoiceCorpus } from "./corpus-generator";
import {
	scoreDiarization,
	scoreEntityExtraction,
	scoreEotDecision,
	scoreFirstResponseLatency,
	scoreRespondDecision,
	scoreTtsAsrRoundTrip,
	scoreVoiceEntityMatch,
	type VoiceE2eCaseResult,
} from "./e2e-harness";
import type { VoiceScenario } from "./voice-scenario";
import type { VoiceWorkbenchScenarioRun } from "./voice-workbench-report";

/** What the real (or mock) services observed for one turn of audio. */
export interface VoiceTurnObservation {
	/** ASR hypothesis transcript for the turn's audio. */
	hypothesisTranscript: string;
	/** Diarized speaker label, or null when the diarizer missed the turn. */
	predictedSpeakerLabel: string | null;
	/** The EOT classifier decided end-of-turn at this turn's boundary. */
	eotDecided: boolean;
	/** EOT decision latency (ms) from the true boundary, when measured. */
	eotLatencyMs?: number;
	/** The agent decided to respond to this turn. */
	responded: boolean;
	/** Entities inferred from this turn's transcript (name/partner extraction). */
	inferredEntities: string[];
	/** Voice→entity match: the entity the recognized voice resolved to (or null). */
	matchedEntityId: string | null;
	/** First-audio latency (ms) of the agent's spoken reply, when it replied. */
	firstAudioMs?: number;
}

export interface VoiceWorkbenchServices {
	/**
	 * Feed one turn's audio slice through the real services and report what was
	 * observed. The `label` carries the turn's ground truth (so a mock can echo
	 * it); the real adapter ignores it and measures.
	 */
	observeTurn(args: {
		turnIndex: number;
		audio: Float32Array;
		sampleRate: number;
		label: CorpusTurnLabel;
	}): Promise<VoiceTurnObservation>;
}

export interface RunVoiceScenarioHeadlessArgs {
	scenario: VoiceScenario;
	/** The generated/loaded corpus; null when its artifacts are absent. */
	corpus: GeneratedVoiceCorpus | null;
	/** The voice services; null when no backend is provisioned. */
	services: VoiceWorkbenchServices | null;
}

function skipped(
	scenario: VoiceScenario,
	skipReason: string,
): VoiceWorkbenchScenarioRun {
	return {
		scenarioId: scenario.id,
		classes: scenario.classes,
		status: "skipped",
		cases: [],
		skipReason,
	};
}

/**
 * Run one scenario headless and score it. Returns a `skipped` run (never a
 * pass) when the corpus or the backend is absent.
 */
export async function runVoiceScenarioHeadless(
	args: RunVoiceScenarioHeadlessArgs,
): Promise<VoiceWorkbenchScenarioRun> {
	const { scenario, corpus, services } = args;
	if (!corpus) return skipped(scenario, "corpus artifacts absent");
	if (!services) return skipped(scenario, "no voice backend provisioned");

	const assertions = scenario.assertions ?? {};
	const cases: VoiceE2eCaseResult[] = [];

	const eotSamples: Array<{
		decided: boolean;
		expected: boolean;
		latencyMs?: number;
	}> = [];
	const diarSamples: Array<{
		predictedLabel: string | null;
		expectedLabel: string;
	}> = [];
	const respondSamples: Array<{ responded: boolean; expectRespond: boolean }> =
		[];
	const voiceEntitySamples: Array<{
		matchedEntityId: string | null;
		expectedEntityId: string;
	}> = [];
	const inferredEntities: string[] = [];
	const expectedEntities: string[] = [];

	for (const label of corpus.groundTruth.turns) {
		const audio = corpus.pcm.subarray(
			label.segmentStartSample,
			label.segmentEndSample,
		);
		const obs = await services.observeTurn({
			turnIndex: label.index,
			audio,
			sampleRate: corpus.sampleRate,
			label,
		});

		// WER — one round-trip case per turn (referenceTranscript vs ASR hypothesis).
		cases.push(
			scoreTtsAsrRoundTrip({
				referenceText: label.referenceTranscript,
				hypothesisText: obs.hypothesisTranscript,
				...(assertions.maxWer !== undefined
					? { maxWer: assertions.maxWer }
					: {}),
			}),
		);

		// EOT — some corpus segments deliberately stop mid-utterance so the
		// classifier can be scored for false triggers.
		eotSamples.push({
			decided: obs.eotDecided,
			expected: label.expectEndOfTurn ?? true,
			...(obs.eotLatencyMs !== undefined
				? { latencyMs: obs.eotLatencyMs }
				: {}),
		});
		diarSamples.push({
			predictedLabel: obs.predictedSpeakerLabel,
			expectedLabel: label.speaker,
		});
		respondSamples.push({
			responded: obs.responded,
			expectRespond: label.expectRespond,
		});
		if (label.entityId) {
			voiceEntitySamples.push({
				matchedEntityId: obs.matchedEntityId,
				expectedEntityId: label.entityId,
			});
		}
		if (label.expectedEntity) expectedEntities.push(label.expectedEntity);
		inferredEntities.push(...obs.inferredEntities);

		if (obs.responded && typeof obs.firstAudioMs === "number") {
			cases.push(
				scoreFirstResponseLatency({
					turnStartedAtMs: 0,
					ttsFirstAudioAtMs: obs.firstAudioMs,
					...(assertions.maxFirstAudioMs !== undefined
						? { maxFirstAudioMs: assertions.maxFirstAudioMs }
						: {}),
				}),
			);
		}
	}

	cases.push(
		scoreEotDecision(eotSamples, {
			...(assertions.maxEotFalseTriggerRate !== undefined
				? { maxFalseTriggerRate: assertions.maxEotFalseTriggerRate }
				: {}),
		}),
	);
	cases.push(
		scoreDiarization(diarSamples, {
			...(assertions.maxDer !== undefined ? { maxDer: assertions.maxDer } : {}),
		}),
	);
	cases.push(
		scoreRespondDecision(respondSamples, {
			...(assertions.minRespondAccuracy !== undefined
				? { minAccuracy: assertions.minRespondAccuracy }
				: {}),
		}),
	);
	// Entity extraction + voice→entity match only when the scenario asserts them.
	if (expectedEntities.length > 0 || inferredEntities.length > 0) {
		cases.push(
			scoreEntityExtraction({
				expected: expectedEntities,
				inferred: inferredEntities,
			}),
		);
	}
	if (voiceEntitySamples.length > 0) {
		cases.push(
			scoreVoiceEntityMatch(voiceEntitySamples, {
				...(assertions.minVoiceEntityMatchRate !== undefined
					? { minMatchRate: assertions.minVoiceEntityMatchRate }
					: {}),
			}),
		);
	}

	return {
		scenarioId: scenario.id,
		classes: scenario.classes,
		status: "ran",
		cases,
	};
}

export interface RunVoiceWorkbenchArgs {
	scenarios: ReadonlyArray<{
		scenario: VoiceScenario;
		corpus: GeneratedVoiceCorpus | null;
	}>;
	services: VoiceWorkbenchServices | null;
}

/** Run a matrix of scenarios headless, returning one run per scenario. */
export async function runVoiceWorkbenchHeadless(
	args: RunVoiceWorkbenchArgs,
): Promise<VoiceWorkbenchScenarioRun[]> {
	const runs: VoiceWorkbenchScenarioRun[] = [];
	for (const entry of args.scenarios) {
		runs.push(
			await runVoiceScenarioHeadless({
				scenario: entry.scenario,
				corpus: entry.corpus,
				services: args.services,
			}),
		);
	}
	return runs;
}
