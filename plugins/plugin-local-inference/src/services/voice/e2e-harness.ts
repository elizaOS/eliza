/**
 * Pure scoring and validation helpers for the local voice E2E harnesses.
 *
 * This file intentionally does not load models, touch the filesystem, or
 * start servers. Hardware scripts feed it real measurements; unit tests can
 * exercise the orchestration logic without native artifacts.
 *
 * Word-error-rate scoring lives in `@elizaos/shared/voice-wer` (the single
 * source of truth shared with the headful self-test, #8785); it is re-exported
 * here so existing `./e2e-harness` importers keep working unchanged.
 */

export { normalizeWerText, wordErrorRate } from "@elizaos/shared/voice-wer";

import { normalizeWerText, wordErrorRate } from "@elizaos/shared/voice-wer";
import {
	computeDiarizationErrorRate,
	type DiarizationSegment,
} from "./diarization-error-rate";
import { percentile, round1, round4 } from "./metric-math";

export type VoiceE2eHarnessErrorCode =
	| "missing-artifact"
	| "missing-measurement"
	| "invalid-measurement";

export class VoiceE2eHarnessError extends Error {
	readonly code: VoiceE2eHarnessErrorCode;
	readonly details?: unknown;

	constructor(
		code: VoiceE2eHarnessErrorCode,
		message: string,
		details?: unknown,
	) {
		super(message);
		this.name = "VoiceE2eHarnessError";
		this.code = code;
		this.details = details;
	}
}

export interface RequiredVoiceArtifact {
	kind:
		| "bundle-root"
		| "speaker-preset"
		| "tts-model"
		| "tts-tokenizer"
		| "asr-model"
		| "asr-mmproj"
		| "ffi-library"
		| "server-binary";
	path: string;
	minBytes?: number;
	magic?: string;
}

export interface VoiceArtifactProbe {
	exists(path: string): boolean;
	size(path: string): number | null;
	readMagic?(path: string, bytes: number): string | null;
}

export interface VerifiedVoiceArtifact extends RequiredVoiceArtifact {
	size: number | null;
}

export function assertRequiredVoiceArtifacts(
	artifacts: ReadonlyArray<RequiredVoiceArtifact>,
	probe: VoiceArtifactProbe,
): VerifiedVoiceArtifact[] {
	const failures: Array<{
		kind: RequiredVoiceArtifact["kind"];
		path: string;
		reason: string;
	}> = [];
	const verified: VerifiedVoiceArtifact[] = [];

	for (const artifact of artifacts) {
		if (!probe.exists(artifact.path)) {
			failures.push({
				kind: artifact.kind,
				path: artifact.path,
				reason: "not found",
			});
			continue;
		}

		const size = probe.size(artifact.path);
		if (
			artifact.minBytes !== undefined &&
			size !== null &&
			size < artifact.minBytes
		) {
			failures.push({
				kind: artifact.kind,
				path: artifact.path,
				reason: `too small (${size} bytes < ${artifact.minBytes} bytes)`,
			});
			continue;
		}

		if (artifact.magic) {
			const got = probe.readMagic?.(artifact.path, artifact.magic.length);
			if (got !== artifact.magic) {
				failures.push({
					kind: artifact.kind,
					path: artifact.path,
					reason: `bad magic (${JSON.stringify(got)} !== ${JSON.stringify(
						artifact.magic,
					)})`,
				});
				continue;
			}
		}

		verified.push({ ...artifact, size });
	}

	if (failures.length > 0) {
		const list = failures
			.map((f) => `- ${f.kind}: ${f.path} (${f.reason})`)
			.join("\n");
		throw new VoiceE2eHarnessError(
			"missing-artifact",
			`Missing required Eliza-1 voice artifact(s):\n${list}`,
			{ failures },
		);
	}

	return verified;
}

export interface TtsAsrRoundTripInput {
	referenceText: string;
	hypothesisText: string;
	maxWer?: number;
}

export interface TtsAsrRoundTripResult {
	kind: "tts-asr-roundtrip";
	referenceText: string;
	hypothesisText: string;
	normalizedReference: string;
	normalizedHypothesis: string;
	wer: number;
	maxWer: number;
	passed: boolean;
}

export function scoreTtsAsrRoundTrip(
	input: TtsAsrRoundTripInput,
): TtsAsrRoundTripResult {
	const maxWer = input.maxWer ?? 0.15;
	const wer = wordErrorRate(input.referenceText, input.hypothesisText);
	return {
		kind: "tts-asr-roundtrip",
		referenceText: input.referenceText,
		hypothesisText: input.hypothesisText,
		normalizedReference: normalizeWerText(input.referenceText),
		normalizedHypothesis: normalizeWerText(input.hypothesisText),
		wer: round4(wer),
		maxWer,
		passed: wer <= maxWer,
	};
}

export interface BargeInInterruptionInput {
	voiceDetectedAtMs: number;
	ttsCancelledAtMs?: number | null;
	llmCancelledAtMs?: number | null;
	audioDrainedAtMs?: number | null;
	maxCancelMs?: number;
	requireLlmCancel?: boolean;
}

export interface BargeInInterruptionResult {
	kind: "barge-in-interruption";
	ttsCancelMs: number | null;
	llmCancelMs: number | null;
	audioDrainMs: number | null;
	bargeInCancelMs: number;
	maxCancelMs: number;
	passed: boolean;
}

export function scoreBargeInInterruption(
	input: BargeInInterruptionInput,
): BargeInInterruptionResult {
	const maxCancelMs = input.maxCancelMs ?? 250;
	const ttsCancelMs = optionalDuration(
		"voiceDetectedAtMs",
		input.voiceDetectedAtMs,
		"ttsCancelledAtMs",
		input.ttsCancelledAtMs,
	);
	const llmCancelMs = optionalDuration(
		"voiceDetectedAtMs",
		input.voiceDetectedAtMs,
		"llmCancelledAtMs",
		input.llmCancelledAtMs,
	);
	const audioDrainMs = optionalDuration(
		"voiceDetectedAtMs",
		input.voiceDetectedAtMs,
		"audioDrainedAtMs",
		input.audioDrainedAtMs,
	);

	if (ttsCancelMs === null) {
		throw missingMeasurement("ttsCancelledAtMs");
	}
	if (input.requireLlmCancel !== false && llmCancelMs === null) {
		throw missingMeasurement("llmCancelledAtMs");
	}

	const measured = [ttsCancelMs, llmCancelMs, audioDrainMs].filter(
		(value): value is number => value !== null,
	);
	const bargeInCancelMs = Math.max(...measured);
	return {
		kind: "barge-in-interruption",
		ttsCancelMs: round1(ttsCancelMs),
		llmCancelMs: llmCancelMs === null ? null : round1(llmCancelMs),
		audioDrainMs: audioDrainMs === null ? null : round1(audioDrainMs),
		bargeInCancelMs: round1(bargeInCancelMs),
		maxCancelMs,
		passed: bargeInCancelMs <= maxCancelMs,
	};
}

export interface PauseContinuationInput {
	speechPauseAtMs: number;
	continuationAtMs: number;
	speculativeStartedAtMs?: number | null;
	speculativeAbortedAtMs?: number | null;
	finalRestartedAtMs?: number | null;
	committedBeforeContinuationAtMs?: number | null;
	maxContinuationGapMs?: number;
	maxAbortAfterContinuationMs?: number;
	maxRestartAfterContinuationMs?: number;
}

export interface PauseContinuationResult {
	kind: "pause-continuation";
	continuationGapMs: number;
	speculativeStartAfterPauseMs: number | null;
	abortAfterContinuationMs: number;
	restartAfterContinuationMs: number;
	maxContinuationGapMs: number;
	passed: boolean;
}

export function scorePauseContinuation(
	input: PauseContinuationInput,
): PauseContinuationResult {
	const maxContinuationGapMs = input.maxContinuationGapMs ?? 4000;
	const maxAbortAfterContinuationMs = input.maxAbortAfterContinuationMs ?? 250;
	const maxRestartAfterContinuationMs =
		input.maxRestartAfterContinuationMs ?? 1000;
	const continuationGapMs = duration(
		"speechPauseAtMs",
		input.speechPauseAtMs,
		"continuationAtMs",
		input.continuationAtMs,
	);
	const speculativeStartAfterPauseMs = optionalDuration(
		"speechPauseAtMs",
		input.speechPauseAtMs,
		"speculativeStartedAtMs",
		input.speculativeStartedAtMs,
	);
	const abortAfterContinuationMs = duration(
		"continuationAtMs",
		input.continuationAtMs,
		"speculativeAbortedAtMs",
		required(input.speculativeAbortedAtMs, "speculativeAbortedAtMs"),
	);
	const restartAfterContinuationMs = duration(
		"continuationAtMs",
		input.continuationAtMs,
		"finalRestartedAtMs",
		required(input.finalRestartedAtMs, "finalRestartedAtMs"),
	);
	const committedBefore =
		input.committedBeforeContinuationAtMs !== null &&
		input.committedBeforeContinuationAtMs !== undefined &&
		input.committedBeforeContinuationAtMs < input.continuationAtMs;

	return {
		kind: "pause-continuation",
		continuationGapMs: round1(continuationGapMs),
		speculativeStartAfterPauseMs:
			speculativeStartAfterPauseMs === null
				? null
				: round1(speculativeStartAfterPauseMs),
		abortAfterContinuationMs: round1(abortAfterContinuationMs),
		restartAfterContinuationMs: round1(restartAfterContinuationMs),
		maxContinuationGapMs,
		passed:
			!committedBefore &&
			continuationGapMs <= maxContinuationGapMs &&
			abortAfterContinuationMs <= maxAbortAfterContinuationMs &&
			restartAfterContinuationMs <= maxRestartAfterContinuationMs,
	};
}

export interface OptimisticRollbackRestartInput {
	speechPauseAtMs: number;
	continuationAtMs: number;
	checkpointSavedAtMs?: number | null;
	speculativeStartedAtMs?: number | null;
	speculativeAbortedAtMs?: number | null;
	checkpointRestoredAtMs?: number | null;
	restartedAtMs?: number | null;
	maxRestoreAfterContinuationMs?: number;
	maxRestartAfterRestoreMs?: number;
}

export interface OptimisticRollbackRestartResult {
	kind: "optimistic-rollback-restart";
	saveAfterPauseMs: number | null;
	abortAfterContinuationMs: number;
	restoreAfterContinuationMs: number;
	restartAfterRestoreMs: number;
	passed: boolean;
}

export function scoreOptimisticRollbackRestart(
	input: OptimisticRollbackRestartInput,
): OptimisticRollbackRestartResult {
	const maxRestoreAfterContinuationMs =
		input.maxRestoreAfterContinuationMs ?? 300;
	const maxRestartAfterRestoreMs = input.maxRestartAfterRestoreMs ?? 1000;
	const saveAfterPauseMs = optionalDuration(
		"speechPauseAtMs",
		input.speechPauseAtMs,
		"checkpointSavedAtMs",
		input.checkpointSavedAtMs,
	);
	const abortAfterContinuationMs = duration(
		"continuationAtMs",
		input.continuationAtMs,
		"speculativeAbortedAtMs",
		required(input.speculativeAbortedAtMs, "speculativeAbortedAtMs"),
	);
	const restoreAfterContinuationMs = duration(
		"continuationAtMs",
		input.continuationAtMs,
		"checkpointRestoredAtMs",
		required(input.checkpointRestoredAtMs, "checkpointRestoredAtMs"),
	);
	const restartAfterRestoreMs = duration(
		"checkpointRestoredAtMs",
		required(input.checkpointRestoredAtMs, "checkpointRestoredAtMs"),
		"restartedAtMs",
		required(input.restartedAtMs, "restartedAtMs"),
	);

	return {
		kind: "optimistic-rollback-restart",
		saveAfterPauseMs:
			saveAfterPauseMs === null ? null : round1(saveAfterPauseMs),
		abortAfterContinuationMs: round1(abortAfterContinuationMs),
		restoreAfterContinuationMs: round1(restoreAfterContinuationMs),
		restartAfterRestoreMs: round1(restartAfterRestoreMs),
		passed:
			restoreAfterContinuationMs <= maxRestoreAfterContinuationMs &&
			restartAfterRestoreMs <= maxRestartAfterRestoreMs &&
			abortAfterContinuationMs <= maxRestoreAfterContinuationMs,
	};
}

export interface FirstResponseLatencyInput {
	turnStartedAtMs: number;
	asrFinalAtMs?: number | null;
	llmFirstTokenAtMs?: number | null;
	ttsFirstAudioAtMs?: number | null;
	audioFirstPlayedAtMs?: number | null;
	maxFirstAudioMs?: number;
}

export interface FirstResponseLatencyResult {
	kind: "first-response-latency";
	asrFinalMs: number | null;
	firstTokenMs: number | null;
	firstAudioMs: number;
	firstPlayedMs: number | null;
	maxFirstAudioMs: number;
	passed: boolean;
}

export function scoreFirstResponseLatency(
	input: FirstResponseLatencyInput,
): FirstResponseLatencyResult {
	const maxFirstAudioMs = input.maxFirstAudioMs ?? 1500;
	const asrFinalMs = optionalDuration(
		"turnStartedAtMs",
		input.turnStartedAtMs,
		"asrFinalAtMs",
		input.asrFinalAtMs,
	);
	const firstTokenMs = optionalDuration(
		"turnStartedAtMs",
		input.turnStartedAtMs,
		"llmFirstTokenAtMs",
		input.llmFirstTokenAtMs,
	);
	const firstAudioMs = duration(
		"turnStartedAtMs",
		input.turnStartedAtMs,
		"ttsFirstAudioAtMs",
		required(input.ttsFirstAudioAtMs, "ttsFirstAudioAtMs"),
	);
	const firstPlayedMs = optionalDuration(
		"turnStartedAtMs",
		input.turnStartedAtMs,
		"audioFirstPlayedAtMs",
		input.audioFirstPlayedAtMs,
	);

	return {
		kind: "first-response-latency",
		asrFinalMs: asrFinalMs === null ? null : round1(asrFinalMs),
		firstTokenMs: firstTokenMs === null ? null : round1(firstTokenMs),
		firstAudioMs: round1(firstAudioMs),
		firstPlayedMs: firstPlayedMs === null ? null : round1(firstPlayedMs),
		maxFirstAudioMs,
		passed: firstAudioMs <= maxFirstAudioMs,
	};
}

// ── EOT decision: latency + false-trigger / false-suppression over a stream ──

export interface EotDecisionSample {
	/** The classifier decided end-of-turn here (the agent may jump in). */
	decided: boolean;
	/** Ground truth: this point WAS a real turn boundary. */
	expected: boolean;
	/** Optional ms from the true boundary to the decision (decided samples). */
	latencyMs?: number;
}

export interface EotDecisionResult {
	kind: "eot-decision";
	total: number;
	/** decided where there was no real boundary (jumped in too eagerly). */
	falseTriggerRate: number;
	/** missed a real boundary (held when it should have ended the turn). */
	falseSuppressionRate: number;
	accuracy: number;
	latencyP50Ms: number | null;
	latencyP95Ms: number | null;
	maxFalseTriggerRate: number;
	passed: boolean;
}

export function scoreEotDecision(
	samples: ReadonlyArray<EotDecisionSample>,
	opts: { maxFalseTriggerRate?: number } = {},
): EotDecisionResult {
	const maxFalseTriggerRate = opts.maxFalseTriggerRate ?? 0.1;
	const total = samples.length;
	let falseTrigger = 0;
	let falseSuppression = 0;
	let correct = 0;
	const latencies: number[] = [];
	for (const s of samples) {
		if (s.decided && !s.expected) falseTrigger += 1;
		if (!s.decided && s.expected) falseSuppression += 1;
		if (s.decided === s.expected) correct += 1;
		if (s.decided && typeof s.latencyMs === "number")
			latencies.push(s.latencyMs);
	}
	const ftr = total > 0 ? falseTrigger / total : 0;
	return {
		kind: "eot-decision",
		total,
		falseTriggerRate: round4(ftr),
		falseSuppressionRate: round4(total > 0 ? falseSuppression / total : 0),
		accuracy: round4(total > 0 ? correct / total : 0),
		latencyP50Ms: percentile(latencies, 50),
		latencyP95Ms: percentile(latencies, 95),
		maxFalseTriggerRate,
		passed: total > 0 && ftr <= maxFalseTriggerRate,
	};
}

// ── Respond decision: respond-when-should vs respond-when-shouldn't ──────────

export interface RespondDecisionSample {
	responded: boolean;
	expectRespond: boolean;
}

export interface RespondDecisionResult {
	kind: "respond-decision";
	total: number;
	accuracy: number;
	/** responded when it should NOT have (talked over / answered a bystander). */
	falsePositiveRate: number;
	/** stayed silent when it SHOULD have replied. */
	falseNegativeRate: number;
	minAccuracy: number;
	passed: boolean;
}

export function scoreRespondDecision(
	samples: ReadonlyArray<RespondDecisionSample>,
	opts: { minAccuracy?: number } = {},
): RespondDecisionResult {
	const minAccuracy = opts.minAccuracy ?? 0.9;
	const total = samples.length;
	let correct = 0;
	let fp = 0;
	let fn = 0;
	let shouldNot = 0;
	let should = 0;
	for (const s of samples) {
		if (s.responded === s.expectRespond) correct += 1;
		if (s.expectRespond) should += 1;
		else shouldNot += 1;
		if (s.responded && !s.expectRespond) fp += 1;
		if (!s.responded && s.expectRespond) fn += 1;
	}
	const accuracy = total > 0 ? correct / total : 0;
	return {
		kind: "respond-decision",
		total,
		accuracy: round4(accuracy),
		falsePositiveRate: round4(shouldNot > 0 ? fp / shouldNot : 0),
		falseNegativeRate: round4(should > 0 ? fn / should : 0),
		minAccuracy,
		passed: total > 0 && accuracy >= minAccuracy,
	};
}

// ── Diarization: DER (speaker-confusion) against ground-truth labels ─────────

export interface DiarizationSample {
	predictedLabel: string | null;
	expectedLabel: string;
}

export interface DiarizationResult {
	kind: "diarization";
	total: number;
	/** Diarization error rate: fraction of turns whose speaker was wrong/missing. */
	der: number;
	confusions: number;
	misses: number;
	maxDer: number;
	passed: boolean;
}

export function scoreDiarization(
	samples: ReadonlyArray<DiarizationSample>,
	opts: { maxDer?: number } = {},
): DiarizationResult {
	const maxDer = opts.maxDer ?? 0.2;
	const total = samples.length;
	let confusions = 0;
	let misses = 0;
	for (const s of samples) {
		if (s.predictedLabel === null) misses += 1;
		else if (s.predictedLabel !== s.expectedLabel) confusions += 1;
	}
	const der = total > 0 ? (confusions + misses) / total : 0;
	return {
		kind: "diarization",
		total,
		der: round4(der),
		confusions,
		misses,
		maxDer,
		passed: total > 0 && der <= maxDer,
	};
}

/** One scored turn for timeline DER: its speech span + predicted/true speaker. */
export interface DiarizationTurnSample {
	/** Ground-truth speaker label (the diarization reference). */
	expectedLabel: string;
	/** Predicted speaker label from a real attributor, or null when it missed. */
	predictedLabel: string | null;
	/** Speech-region start of this turn (ms into the stream). */
	startMs: number;
	/** Speech-region end of this turn (ms; must be ≥ startMs). */
	endMs: number;
}

/**
 * Score diarization with the frame-based, label-agnostic {@link
 * computeDiarizationErrorRate} (#9147) rather than a per-turn string compare.
 * The predicted labels are an arbitrary cluster-id space (the attributor never
 * knows the ground-truth names) — DER finds the optimal cluster→speaker mapping,
 * so a correct partition scores 0 no matter how clusters are named, and a merged
 * or swapped speaker shows up as real error. `confusions`/`misses` are turn-level
 * tallies derived from that optimal mapping, for the report.
 */
export function scoreDiarizationTimeline(
	turns: ReadonlyArray<DiarizationTurnSample>,
	opts: { maxDer?: number } = {},
): DiarizationResult {
	const maxDer = opts.maxDer ?? 0.2;
	const reference: DiarizationSegment[] = turns.map((t) => ({
		speaker: t.expectedLabel,
		startMs: t.startMs,
		endMs: t.endMs,
	}));
	const hypothesis: DiarizationSegment[] = turns
		.filter((t) => t.predictedLabel !== null)
		.map((t) => ({
			speaker: t.predictedLabel as string,
			startMs: t.startMs,
			endMs: t.endMs,
		}));
	const result = computeDiarizationErrorRate(reference, hypothesis);
	// Turn-level tallies under the optimal mapping (the report's headline is `der`).
	let confusions = 0;
	let misses = 0;
	for (const t of turns) {
		if (t.predictedLabel === null) {
			misses += 1;
		} else if (result.mapping[t.predictedLabel] !== t.expectedLabel) {
			confusions += 1;
		}
	}
	return {
		kind: "diarization",
		total: turns.length,
		der: round4(result.der),
		confusions,
		misses,
		maxDer,
		passed: turns.length > 0 && result.der <= maxDer,
	};
}

// ── Entity extraction: inferred name/entity match (precision / recall / F1) ──

export interface EntityExtractionInput {
	expected: ReadonlyArray<string>;
	inferred: ReadonlyArray<string>;
}

export interface EntityExtractionResult {
	kind: "entity-extraction";
	precision: number;
	recall: number;
	f1: number;
	minF1: number;
	passed: boolean;
}

function normEntity(s: string): string {
	return s.trim().toLowerCase();
}

export function scoreEntityExtraction(
	input: EntityExtractionInput,
	opts: { minF1?: number } = {},
): EntityExtractionResult {
	const minF1 = opts.minF1 ?? 0.8;
	const expected = new Set(input.expected.map(normEntity).filter(Boolean));
	const inferred = new Set(input.inferred.map(normEntity).filter(Boolean));
	let tp = 0;
	for (const e of inferred) if (expected.has(e)) tp += 1;
	const precision =
		inferred.size > 0 ? tp / inferred.size : expected.size === 0 ? 1 : 0;
	const recall = expected.size > 0 ? tp / expected.size : 1;
	const f1 =
		precision + recall > 0
			? (2 * precision * recall) / (precision + recall)
			: 0;
	return {
		kind: "entity-extraction",
		precision: round4(precision),
		recall: round4(recall),
		f1: round4(f1),
		minF1,
		passed: f1 >= minF1,
	};
}

// ── Voice→entity match: recognized voice resolves to the right entity ────────

export interface VoiceEntityMatchSample {
	matchedEntityId: string | null;
	expectedEntityId: string;
}

export interface VoiceEntityMatchResult {
	kind: "voice-entity-match";
	total: number;
	matchRate: number;
	correct: number;
	minMatchRate: number;
	passed: boolean;
}

export function scoreVoiceEntityMatch(
	samples: ReadonlyArray<VoiceEntityMatchSample>,
	opts: { minMatchRate?: number } = {},
): VoiceEntityMatchResult {
	const minMatchRate = opts.minMatchRate ?? 0.9;
	const total = samples.length;
	let correct = 0;
	for (const s of samples) {
		if (s.matchedEntityId === s.expectedEntityId) correct += 1;
	}
	const matchRate = total > 0 ? correct / total : 0;
	return {
		kind: "voice-entity-match",
		total,
		matchRate: round4(matchRate),
		correct,
		minMatchRate,
		passed: total > 0 && matchRate >= minMatchRate,
	};
}

// ── Echo / self-voice rejection: the agent's own TTS must not be a user turn ─

export interface EchoRejectionSample {
	/** Ground truth: this turn is the agent's own TTS echoed back through the mic. */
	isAgentEcho: boolean;
	/** The agent responded to (i.e. failed to suppress) this turn. */
	responded: boolean;
}

export interface EchoRejectionResult {
	kind: "echo-rejection";
	/** Number of agent-echo turns scored. */
	total: number;
	/** Echo turns correctly suppressed (no response). */
	rejected: number;
	rejectionRate: number;
	minRejectionRate: number;
	passed: boolean;
}

/**
 * Score self-echo rejection over the agent-echo turns only: each must be
 * suppressed (no response). Real turns are scored by {@link scoreRespondDecision}
 * — this isolates "did the agent talk to itself?".
 */
export function scoreEchoRejection(
	samples: ReadonlyArray<EchoRejectionSample>,
	opts: { minRejectionRate?: number } = {},
): EchoRejectionResult {
	const minRejectionRate = opts.minRejectionRate ?? 0.9;
	const echo = samples.filter((s) => s.isAgentEcho);
	const total = echo.length;
	let rejected = 0;
	for (const s of echo) if (!s.responded) rejected += 1;
	const rejectionRate = total > 0 ? rejected / total : 0;
	return {
		kind: "echo-rejection",
		total,
		rejected,
		rejectionRate: round4(rejectionRate),
		minRejectionRate,
		passed: total > 0 && rejectionRate >= minRejectionRate,
	};
}

// ── Owner security: owner vs. intruder gating (never accept an impostor) ──────

export interface OwnerSecuritySample {
	/** The system judged this turn to be the device owner. */
	predictedOwner: boolean;
	/** Ground truth: this turn IS the owner. */
	expectedOwner: boolean;
}

export interface OwnerSecurityResult {
	kind: "owner-security";
	total: number;
	accuracy: number;
	/** Accepted a non-owner AS the owner (the dangerous false-accept). */
	impostorAcceptRate: number;
	/** Rejected the real owner (a friction false-reject). */
	ownerRejectRate: number;
	minAccuracy: number;
	maxImpostorAcceptRate: number;
	passed: boolean;
}

/**
 * Score owner-vs-intruder gating. Passing requires both high overall accuracy
 * AND an impostor-accept rate at/below the (strict, default 0) ceiling —
 * letting a stranger in is the failure mode that matters for security, so it is
 * gated separately from plain accuracy.
 */
export function scoreOwnerSecurity(
	samples: ReadonlyArray<OwnerSecuritySample>,
	opts: { minAccuracy?: number; maxImpostorAcceptRate?: number } = {},
): OwnerSecurityResult {
	const minAccuracy = opts.minAccuracy ?? 0.9;
	const maxImpostorAcceptRate = opts.maxImpostorAcceptRate ?? 0;
	const total = samples.length;
	let correct = 0;
	let impostorAccept = 0;
	let ownerReject = 0;
	let owners = 0;
	let nonOwners = 0;
	for (const s of samples) {
		if (s.predictedOwner === s.expectedOwner) correct += 1;
		if (s.expectedOwner) owners += 1;
		else nonOwners += 1;
		if (s.predictedOwner && !s.expectedOwner) impostorAccept += 1;
		if (!s.predictedOwner && s.expectedOwner) ownerReject += 1;
	}
	const accuracy = total > 0 ? correct / total : 0;
	const impostorAcceptRate = nonOwners > 0 ? impostorAccept / nonOwners : 0;
	return {
		kind: "owner-security",
		total,
		accuracy: round4(accuracy),
		impostorAcceptRate: round4(impostorAcceptRate),
		ownerRejectRate: round4(owners > 0 ? ownerReject / owners : 0),
		minAccuracy,
		maxImpostorAcceptRate,
		passed:
			total > 0 &&
			accuracy >= minAccuracy &&
			impostorAcceptRate <= maxImpostorAcceptRate,
	};
}

// ── Speaker-gated barge-in: right turns cancel TTS fast, wrong ones never do ──

export interface BargeInGatingSample {
	/** Ground truth: this barge-in SHOULD hard-stop the agent's TTS. */
	expectCancel: boolean;
	/** Measured cancel latency (ms), or null when the agent did NOT cancel. */
	cancelMs: number | null;
}

export interface BargeInGatingResult {
	kind: "barge-in-gating";
	total: number;
	/** Fraction of barge-ins gated correctly (right ones cancelled in-budget, wrong ones held). */
	gatingAccuracy: number;
	/** Cancelled when it should have held (echo / bystander hard-stopped the agent). */
	wrongCancels: number;
	/** Should have cancelled but held, or cancelled past the budget. */
	missedCancels: number;
	/** Slowest legitimate cancel (ms), or null when none cancelled. */
	worstCancelMs: number | null;
	maxCancelMs: number;
	passed: boolean;
}

/**
 * Score speaker-gated barge-in over the barge-in turns. A turn is gated correctly
 * when it either (a) SHOULD cancel and did so within `maxCancelMs`, or (b) should
 * NOT cancel and did not. Passing requires EVERY barge-in gated correctly: letting
 * the agent's own echo or a bystander hard-stop it, or failing to yield to a
 * wake-word interjection, is a hard failure — not a rate to average away.
 */
export function scoreBargeInGating(
	samples: ReadonlyArray<BargeInGatingSample>,
	opts: { maxCancelMs?: number } = {},
): BargeInGatingResult {
	const maxCancelMs = opts.maxCancelMs ?? 250;
	const total = samples.length;
	let correct = 0;
	let wrongCancels = 0;
	let missedCancels = 0;
	const legitCancelMs: number[] = [];
	for (const s of samples) {
		const cancelled = s.cancelMs !== null;
		if (s.expectCancel) {
			if (cancelled && (s.cancelMs as number) <= maxCancelMs) correct += 1;
			else missedCancels += 1;
			if (cancelled) legitCancelMs.push(s.cancelMs as number);
		} else {
			if (!cancelled) correct += 1;
			else wrongCancels += 1;
		}
	}
	return {
		kind: "barge-in-gating",
		total,
		gatingAccuracy: round4(total > 0 ? correct / total : 0),
		wrongCancels,
		missedCancels,
		worstCancelMs:
			legitCancelMs.length > 0 ? round1(Math.max(...legitCancelMs)) : null,
		maxCancelMs,
		passed: total > 0 && correct === total,
	};
}

// ── ERLE: echo-return-loss-enhancement floor on AEC scenarios ────────────────

export interface ErleResult {
	kind: "erle";
	/** Number of AEC echo turns with an ERLE measurement. */
	total: number;
	/** Worst (minimum) ERLE across the turns — the gate compares this to the floor. */
	worstErleDb: number;
	meanErleDb: number;
	minErleDb: number;
	passed: boolean;
}

/**
 * Score echo-return-loss-enhancement against a floor (dB). Passing requires the
 * WORST turn to clear the floor: a single un-cancelled echo burst is a failure.
 * Infinite ERLE (a perfectly silent residual) counts as clearing the floor but is
 * excluded from the mean so one silent turn cannot mask a weak one.
 */
export function scoreErle(
	samples: ReadonlyArray<{ erleDb: number }>,
	opts: { minErleDb?: number } = {},
): ErleResult {
	const minErleDb = opts.minErleDb ?? 18;
	const values = samples.map((s) => s.erleDb);
	const worst = values.length > 0 ? Math.min(...values) : 0;
	const finite = values.filter((v) => Number.isFinite(v));
	const mean =
		finite.length > 0 ? finite.reduce((a, b) => a + b, 0) / finite.length : 0;
	return {
		kind: "erle",
		total: values.length,
		worstErleDb: Number.isFinite(worst) ? round1(worst) : worst,
		meanErleDb: round1(mean),
		minErleDb,
		passed: values.length > 0 && worst >= minErleDb,
	};
}

// ── Streaming-ASR partial monotonicity: the committed prefix never retracts ───

export interface PartialMonotonicityResult {
	kind: "partial-monotonicity";
	/** Number of partial→partial transitions checked (partials.length - 1). */
	total: number;
	/** Transitions where the next partial did not extend the previous committed prefix. */
	retractions: number;
	passed: boolean;
}

/**
 * Score partial-transcript monotonicity over an ordered sequence of committed
 * prefixes emitted by streaming ASR. Each partial must be a prefix-extension of
 * the one before it (the stabilizer commits forward and never rewrites what it
 * already emitted). Any retraction fails the gate. A single-element (or empty)
 * sequence has nothing to retract and does not pass on its own — the caller only
 * scores turns that actually produced a partial stream.
 */
export function scorePartialMonotonicity(
	partials: ReadonlyArray<string>,
): PartialMonotonicityResult {
	let retractions = 0;
	for (let i = 1; i < partials.length; i++) {
		const prev = partials[i - 1].trim();
		const next = partials[i].trim();
		if (prev.length > 0 && !next.startsWith(prev)) retractions += 1;
	}
	const total = Math.max(0, partials.length - 1);
	return {
		kind: "partial-monotonicity",
		total,
		retractions,
		passed: total > 0 && retractions === 0,
	};
}

export type VoiceE2eCaseResult =
	| TtsAsrRoundTripResult
	| BargeInInterruptionResult
	| BargeInGatingResult
	| PauseContinuationResult
	| OptimisticRollbackRestartResult
	| FirstResponseLatencyResult
	| EotDecisionResult
	| RespondDecisionResult
	| DiarizationResult
	| EntityExtractionResult
	| VoiceEntityMatchResult
	| EchoRejectionResult
	| OwnerSecurityResult
	| ErleResult
	| PartialMonotonicityResult;

export interface VoiceE2eSummary {
	passed: boolean;
	cases: VoiceE2eCaseResult[];
}

export function summarizeVoiceE2e(
	cases: ReadonlyArray<VoiceE2eCaseResult>,
): VoiceE2eSummary {
	return {
		passed: cases.length > 0 && cases.every((c) => c.passed),
		cases: [...cases],
	};
}

function required(value: number | null | undefined, name: string): number {
	if (value === null || value === undefined || !Number.isFinite(value)) {
		throw missingMeasurement(name);
	}
	return value;
}

function optionalDuration(
	fromName: string,
	from: number,
	toName: string,
	to: number | null | undefined,
): number | null {
	if (to === null || to === undefined) return null;
	return duration(fromName, from, toName, to);
}

function duration(
	fromName: string,
	from: number,
	toName: string,
	to: number,
): number {
	if (!Number.isFinite(from)) throw missingMeasurement(fromName);
	if (!Number.isFinite(to)) throw missingMeasurement(toName);
	const delta = to - from;
	if (delta < 0) {
		throw new VoiceE2eHarnessError(
			"invalid-measurement",
			`Invalid voice E2E measurement: ${toName} (${to}) is before ${fromName} (${from})`,
			{ fromName, from, toName, to },
		);
	}
	return delta;
}

function missingMeasurement(name: string): VoiceE2eHarnessError {
	return new VoiceE2eHarnessError(
		"missing-measurement",
		`Missing required voice E2E measurement: ${name}`,
		{ name },
	);
}
