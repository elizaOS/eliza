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

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
	CorpusGroundTruth,
	CorpusTurnLabel,
	GeneratedVoiceCorpus,
} from "./corpus-generator";
import {
	type DiarizationTurnSample,
	scoreBargeInGating,
	scoreDiarizationTimeline,
	scoreEchoRejection,
	scoreEntityExtraction,
	scoreEotDecision,
	scoreErle,
	scoreFirstResponseLatency,
	scoreOwnerSecurity,
	scorePartialMonotonicity,
	scoreRespondDecision,
	scoreTtsAsrRoundTrip,
	scoreVoiceEntityMatch,
	type VoiceE2eCaseResult,
} from "./e2e-harness";
import type { VoiceScenario } from "./voice-scenario";
import type {
	VoiceAudioArtifact,
	VoiceWorkbenchScenarioRun,
} from "./voice-workbench-report";
import { encodeMonoPcm16Wav } from "./wav-codec";

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
	/** The system judged this turn to be the device owner (owner-security). */
	predictedOwner?: boolean;
	/**
	 * For a barge-in turn: the measured cancel latency (ms) of the agent's TTS, or
	 * null when the agent (correctly or not) did NOT cancel. Absent ⇒ the lane has
	 * no barge-in signal for this turn and it is not scored.
	 */
	bargeInCancelMs?: number | null;
	/**
	 * Echo-return-loss-enhancement (dB) measured by the AEC on an echo turn. Absent
	 * ⇒ the lane has no AEC feed (honestly unscored — never a fabricated pass).
	 */
	erleDb?: number;
	/**
	 * Ordered streaming-ASR partial hypotheses for this turn. Absent ⇒ the lane has
	 * no streaming ASR (batch transcription only) and monotonicity is not scored.
	 */
	partialTranscripts?: string[];
}

export interface VoiceWorkbenchServices {
	/**
	 * Optional one-shot hook before a scenario's turns are scored. Real services
	 * use this to enroll speaker centroids from the generated corpus; mock
	 * services can omit it.
	 */
	prepareScenario?(args: {
		scenario: VoiceScenario;
		corpus: GeneratedVoiceCorpus;
	}): Promise<void> | void;
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
		/** Scenario-level ground truth (participants, owner set, agents). */
		groundTruth: CorpusGroundTruth;
	}): Promise<VoiceTurnObservation>;
}

/**
 * Where to write per-run `.wav` artifacts. When present, the runner encodes the
 * full corpus + each consumed per-turn slice to disk under `dir` and records the
 * paths (relative to `relativeTo`) on the run's `audioArtifacts`. Absent ⇒ no IO.
 */
export interface VoiceAudioCaptureSink {
	/** Directory the `.wav` files are written into (created recursively). */
	dir: string;
	/** Artifact paths are recorded relative to this dir (the scenario run dir). */
	relativeTo: string;
}

export interface RunVoiceScenarioHeadlessArgs {
	scenario: VoiceScenario;
	/** The generated/loaded corpus; null when its artifacts are absent. */
	corpus: GeneratedVoiceCorpus | null;
	/** The voice services; null when no backend is provisioned. */
	services: VoiceWorkbenchServices | null;
	/** When set, write the run's audio as `.wav` artifacts and record their paths. */
	captureAudio?: VoiceAudioCaptureSink;
}

/** Encode `pcm` to `<dir>/<fileName>` and return a relative-path artifact. */
function writeAudioArtifact(args: {
	sink: VoiceAudioCaptureSink;
	fileName: string;
	pcm: Float32Array;
	sampleRate: number;
	turnIndex: number;
	kind: VoiceAudioArtifact["kind"];
	speakerLabel?: string;
}): VoiceAudioArtifact {
	const absolutePath = path.join(args.sink.dir, args.fileName);
	writeFileSync(absolutePath, encodeMonoPcm16Wav(args.pcm, args.sampleRate));
	const relativePath = path
		.relative(args.sink.relativeTo, absolutePath)
		.split(path.sep)
		.join("/");
	return {
		turnIndex: args.turnIndex,
		kind: args.kind,
		path: relativePath,
		sampleRate: args.sampleRate,
		durationMs: Math.round((args.pcm.length / args.sampleRate) * 1000),
		...(args.speakerLabel !== undefined
			? { speakerLabel: args.speakerLabel }
			: {}),
	};
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
	const { scenario, corpus, services, captureAudio } = args;
	if (!corpus) return skipped(scenario, "corpus artifacts absent");
	if (!services) return skipped(scenario, "no voice backend provisioned");

	const assertions = scenario.assertions ?? {};
	const cases: VoiceE2eCaseResult[] = [];
	await services.prepareScenario?.({ scenario, corpus });

	// When a capture sink is active, write the full corpus once + each per-turn
	// slice as `.wav` artifacts and record their (run-dir-relative) paths.
	const audioArtifacts: VoiceAudioArtifact[] = [];
	if (captureAudio) {
		mkdirSync(captureAudio.dir, { recursive: true });
		audioArtifacts.push(
			writeAudioArtifact({
				sink: captureAudio,
				fileName: "corpus.wav",
				pcm: corpus.pcm,
				sampleRate: corpus.sampleRate,
				turnIndex: 0,
				kind: "generated",
			}),
		);
	}

	const eotSamples: Array<{
		decided: boolean;
		expected: boolean;
		latencyMs?: number;
	}> = [];
	const diarTurns: DiarizationTurnSample[] = [];
	const respondSamples: Array<{ responded: boolean; expectRespond: boolean }> =
		[];
	const voiceEntitySamples: Array<{
		matchedEntityId: string | null;
		expectedEntityId: string;
	}> = [];
	const inferredEntities: string[] = [];
	const expectedEntities: string[] = [];
	const echoSamples: Array<{ isAgentEcho: boolean; responded: boolean }> = [];
	const ownerSamples: Array<{
		predictedOwner: boolean;
		expectedOwner: boolean;
	}> = [];
	const bargeInSamples: Array<{
		expectCancel: boolean;
		cancelMs: number | null;
	}> = [];
	const erleSamples: Array<{ erleDb: number }> = [];
	const partialCases: VoiceE2eCaseResult[] = [];
	const wantsOwnerScoring = scenario.classes.includes("owner-security");

	for (const label of corpus.groundTruth.turns) {
		const audio = corpus.pcm.subarray(
			label.segmentStartSample,
			label.segmentEndSample,
		);
		if (captureAudio) {
			audioArtifacts.push(
				writeAudioArtifact({
					sink: captureAudio,
					fileName: `turn-${label.index}.wav`,
					pcm: audio,
					sampleRate: corpus.sampleRate,
					turnIndex: label.index,
					kind: "consumed",
					speakerLabel: label.speaker,
				}),
			);
		}
		const obs = await services.observeTurn({
			turnIndex: label.index,
			audio,
			sampleRate: corpus.sampleRate,
			label,
			groundTruth: corpus.groundTruth,
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
		// Diarization scores REAL speaker turns only — an agent-echo turn is the
		// agent's own voice bleeding back, not a speaker to attribute, so it is
		// handled by the echo-rejection scorer instead.
		if (!label.isAgentEcho) {
			diarTurns.push({
				predictedLabel: obs.predictedSpeakerLabel,
				expectedLabel: label.speaker,
				startMs: (label.speechStartSample / corpus.sampleRate) * 1000,
				endMs: (label.speechEndSample / corpus.sampleRate) * 1000,
			});
		}
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

		if (label.isAgentEcho) {
			echoSamples.push({ isAgentEcho: true, responded: obs.responded });
		}
		if (wantsOwnerScoring && typeof obs.predictedOwner === "boolean") {
			ownerSamples.push({
				predictedOwner: obs.predictedOwner,
				expectedOwner: label.isOwner === true,
			});
		}

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

		// Speaker-gated barge-in: only barge-in turns with a measured decision
		// (cancelled or explicitly held via `null`). Absent ⇒ the lane has no
		// barge-in signal and the turn is not scored.
		if (label.bargeIn && obs.bargeInCancelMs !== undefined) {
			bargeInSamples.push({
				expectCancel: label.expectBargeInCancel === true,
				cancelMs: obs.bargeInCancelMs,
			});
		}
		// ERLE only when the lane produced an AEC measurement for this turn.
		if (typeof obs.erleDb === "number") {
			erleSamples.push({ erleDb: obs.erleDb });
		}
		// Partial-transcript monotonicity only when the lane produced a partial
		// stream (streaming ASR); batch-only lanes skip it honestly.
		if (obs.partialTranscripts && obs.partialTranscripts.length > 0) {
			partialCases.push(scorePartialMonotonicity(obs.partialTranscripts));
		}
	}

	cases.push(
		scoreEotDecision(eotSamples, {
			...(assertions.maxEotFalseTriggerRate !== undefined
				? { maxFalseTriggerRate: assertions.maxEotFalseTriggerRate }
				: {}),
		}),
	);
	if (diarTurns.length > 0) {
		cases.push(
			scoreDiarizationTimeline(diarTurns, {
				...(assertions.maxDer !== undefined
					? { maxDer: assertions.maxDer }
					: {}),
			}),
		);
	}
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
			scoreEntityExtraction(
				{
					expected: expectedEntities,
					inferred: inferredEntities,
				},
				{
					...(assertions.minEntityF1 !== undefined
						? { minF1: assertions.minEntityF1 }
						: {}),
				},
			),
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
	if (echoSamples.length > 0) {
		cases.push(
			scoreEchoRejection(echoSamples, {
				...(assertions.minEchoRejectionRate !== undefined
					? { minRejectionRate: assertions.minEchoRejectionRate }
					: {}),
			}),
		);
	}
	if (ownerSamples.length > 0) {
		cases.push(
			scoreOwnerSecurity(ownerSamples, {
				...(assertions.minOwnerAccuracy !== undefined
					? { minAccuracy: assertions.minOwnerAccuracy }
					: {}),
			}),
		);
	}
	if (bargeInSamples.length > 0) {
		cases.push(
			scoreBargeInGating(bargeInSamples, {
				...(assertions.maxBargeInCancelMs !== undefined
					? { maxCancelMs: assertions.maxBargeInCancelMs }
					: {}),
			}),
		);
	}
	if (erleSamples.length > 0) {
		cases.push(
			scoreErle(erleSamples, {
				...(assertions.minErleDb !== undefined
					? { minErleDb: assertions.minErleDb }
					: {}),
			}),
		);
	}
	cases.push(...partialCases);

	return {
		scenarioId: scenario.id,
		classes: scenario.classes,
		status: "ran",
		cases,
		...(audioArtifacts.length > 0 ? { audioArtifacts } : {}),
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
