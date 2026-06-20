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

/** Nearest-rank percentile over a sample (null when empty). */
function percentile(values: ReadonlyArray<number>, p: number): number | null {
	const finite = values.filter((v) => Number.isFinite(v));
	if (finite.length === 0) return null;
	const sorted = [...finite].sort((a, b) => a - b);
	const rank = Math.ceil((p / 100) * sorted.length);
	return round1(sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]);
}

export type VoiceE2eCaseResult =
	| TtsAsrRoundTripResult
	| BargeInInterruptionResult
	| PauseContinuationResult
	| OptimisticRollbackRestartResult
	| FirstResponseLatencyResult
	| EotDecisionResult
	| RespondDecisionResult
	| DiarizationResult
	| EntityExtractionResult
	| VoiceEntityMatchResult;

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

function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

function round4(value: number): number {
	return Math.round(value * 10000) / 10000;
}
