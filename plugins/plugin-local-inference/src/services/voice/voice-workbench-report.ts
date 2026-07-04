/**
 * Voice Workbench benchmark report (#8785).
 *
 * Rolls a matrix of per-scenario scorer results into one machine-readable
 * report + a Markdown rendering, mirroring `voicebench`'s p95/p99 output and the
 * `summarizeVoiceE2e` verdict shape. Pure: it consumes already-scored
 * `VoiceE2eCaseResult`s (the runners — headless services / headful frontend —
 * produce those), so it can be unit-tested without audio, models, or a browser.
 *
 * Honesty contract: a scenario whose corpus/backend artifacts are absent is
 * `skipped`, never `pass`. `overall` is `skipped` only when *every* scenario was
 * skipped; one ran-and-failed scenario makes the whole report `fail`.
 */

import type { VoiceE2eCaseResult } from "./e2e-harness";
import { percentile, round4 } from "./metric-math";
import type { VoiceScenarioClass } from "./voice-scenario";

export type VoiceWorkbenchStatus = "ran" | "skipped";
export type VoiceWorkbenchVerdict = "pass" | "fail" | "skipped";

/**
 * A `.wav` artifact written for one scenario run when a capture sink is active.
 * `path` is RELATIVE to the run dir the headless runner was told to write under,
 * so the scenario run viewer (served from that dir) can reference it directly.
 */
export interface VoiceAudioArtifact {
	/** Turn index this artifact belongs to; the full corpus uses turn 0. */
	turnIndex: number;
	/** `generated` = the full synthesized corpus; `consumed` = a per-turn slice. */
	kind: "generated" | "consumed";
	/** Path to the `.wav`, relative to the run dir (forward-slash separated). */
	path: string;
	sampleRate: number;
	durationMs?: number;
	/** Diarization ground-truth speaker label for a consumed per-turn slice. */
	speakerLabel?: string;
}

/** One scenario's outcome in a workbench run. */
export interface VoiceWorkbenchScenarioRun {
	scenarioId: string;
	classes: VoiceScenarioClass[];
	/** `skipped` when corpus/backend artifacts were absent (never scored). */
	status: VoiceWorkbenchStatus;
	/** Scored cases for this scenario (empty when skipped). */
	cases: VoiceE2eCaseResult[];
	/** Why the scenario was skipped (artifact/backend absence), if it was. */
	skipReason?: string;
	/** `.wav` artifacts written when a capture sink was active (else absent). */
	audioArtifacts?: VoiceAudioArtifact[];
}

export interface VoiceWorkbenchScenarioReport {
	scenarioId: string;
	classes: VoiceScenarioClass[];
	status: VoiceWorkbenchStatus;
	verdict: VoiceWorkbenchVerdict;
	caseCount: number;
	failedCaseKinds: string[];
	skipReason?: string;
}

/** Mean + worst + sample-count for one metric across all ran scenarios. */
export interface MetricRollup {
	count: number;
	mean: number | null;
	worst: number | null;
}

export interface VoiceWorkbenchMetrics {
	/** Transcription word-error-rate (`worst` = max). */
	wer: MetricRollup;
	/** EOT false-trigger rate (`worst` = max) + latency percentiles. */
	eotFalseTriggerRate: MetricRollup;
	eotLatencyP50Ms: number | null;
	eotLatencyP95Ms: number | null;
	/** Diarization error rate (`worst` = max). */
	der: MetricRollup;
	/** Respond-decision accuracy (`worst` = min). */
	respondAccuracy: MetricRollup;
	/** Entity-extraction F1 (`worst` = min). */
	entityF1: MetricRollup;
	/** Voice→entity match rate (`worst` = min). */
	voiceEntityMatchRate: MetricRollup;
	/** First-audio latency ms (`worst` = max). */
	firstAudioMs: MetricRollup;
	/** Self-echo rejection rate (`worst` = min). */
	echoRejectionRate: MetricRollup;
	/** Owner-vs-intruder accuracy (`worst` = min). */
	ownerAccuracy: MetricRollup;
	/** Impostor-accept rate (`worst` = max) — non-owner accepted as owner. */
	impostorAcceptRate: MetricRollup;
	/** Speaker-gated barge-in accuracy (`worst` = min) — right turns cancel, wrong ones hold. */
	bargeInGatingAccuracy: MetricRollup;
	/** Legitimate barge-in cancel latency ms (`worst` = max). */
	bargeInCancelMs: MetricRollup;
	/** Echo-return-loss-enhancement dB (`worst` = min) — AEC scenarios only. */
	erleDb: MetricRollup;
	/** Streaming-partial retractions (`worst` = max) — committed prefix rewrites. */
	partialRetractions: MetricRollup;
}

export interface VoiceWorkbenchReport {
	schemaVersion: 1;
	overall: VoiceWorkbenchVerdict;
	scenariosTotal: number;
	scenariosRan: number;
	scenariosSkipped: number;
	scenarios: VoiceWorkbenchScenarioReport[];
	metrics: VoiceWorkbenchMetrics;
}

function mean(values: ReadonlyArray<number>): number | null {
	if (values.length === 0) return null;
	const sum = values.reduce((a, b) => a + b, 0);
	return round4(sum / values.length);
}

function rollupMax(values: ReadonlyArray<number>): MetricRollup {
	return {
		count: values.length,
		mean: mean(values),
		worst: values.length > 0 ? round4(Math.max(...values)) : null,
	};
}

function rollupMin(values: ReadonlyArray<number>): MetricRollup {
	return {
		count: values.length,
		mean: mean(values),
		worst: values.length > 0 ? round4(Math.min(...values)) : null,
	};
}

function scenarioVerdict(
	run: VoiceWorkbenchScenarioRun,
): VoiceWorkbenchVerdict {
	if (run.status === "skipped") return "skipped";
	if (run.cases.length === 0) return "skipped";
	return run.cases.every((c) => c.passed) ? "pass" : "fail";
}

/**
 * Aggregate per-scenario scorer results into one gating report. `overall` is
 * `fail` if any scenario ran and failed, else `pass` if any scenario ran and
 * passed, else `skipped`.
 */
export function buildVoiceWorkbenchReport(
	runs: ReadonlyArray<VoiceWorkbenchScenarioRun>,
): VoiceWorkbenchReport {
	const scenarios: VoiceWorkbenchScenarioReport[] = runs.map((run) => {
		const verdict = scenarioVerdict(run);
		return {
			scenarioId: run.scenarioId,
			classes: run.classes,
			status: run.status,
			verdict,
			caseCount: run.cases.length,
			failedCaseKinds: run.cases.filter((c) => !c.passed).map((c) => c.kind),
			skipReason: run.skipReason,
		};
	});

	const allCases = runs.flatMap((r) => r.cases);
	const wer: number[] = [];
	const ftr: number[] = [];
	const eotLatencyP50: number[] = [];
	const eotLatencyP95: number[] = [];
	const der: number[] = [];
	const respondAccuracy: number[] = [];
	const entityF1: number[] = [];
	const voiceEntityMatchRate: number[] = [];
	const firstAudioMs: number[] = [];
	const echoRejectionRate: number[] = [];
	const ownerAccuracy: number[] = [];
	const impostorAcceptRate: number[] = [];
	const bargeInGatingAccuracy: number[] = [];
	const bargeInCancelMs: number[] = [];
	const erleDb: number[] = [];
	const partialRetractions: number[] = [];

	for (const c of allCases) {
		switch (c.kind) {
			case "tts-asr-roundtrip":
				wer.push(c.wer);
				break;
			case "eot-decision":
				ftr.push(c.falseTriggerRate);
				if (c.latencyP50Ms !== null) eotLatencyP50.push(c.latencyP50Ms);
				if (c.latencyP95Ms !== null) eotLatencyP95.push(c.latencyP95Ms);
				break;
			case "diarization":
				der.push(c.der);
				break;
			case "respond-decision":
				respondAccuracy.push(c.accuracy);
				break;
			case "entity-extraction":
				entityF1.push(c.f1);
				break;
			case "voice-entity-match":
				voiceEntityMatchRate.push(c.matchRate);
				break;
			case "first-response-latency":
				firstAudioMs.push(c.firstAudioMs);
				break;
			case "echo-rejection":
				echoRejectionRate.push(c.rejectionRate);
				break;
			case "owner-security":
				ownerAccuracy.push(c.accuracy);
				impostorAcceptRate.push(c.impostorAcceptRate);
				break;
			case "barge-in-gating":
				bargeInGatingAccuracy.push(c.gatingAccuracy);
				if (c.worstCancelMs !== null) bargeInCancelMs.push(c.worstCancelMs);
				break;
			case "erle":
				// A perfectly-silent residual scores +Infinity; keep the rollup finite.
				if (Number.isFinite(c.worstErleDb)) erleDb.push(c.worstErleDb);
				break;
			case "partial-monotonicity":
				partialRetractions.push(c.retractions);
				break;
			default:
				break;
		}
	}

	const ran = runs.filter((r) => r.status === "ran" && r.cases.length > 0);
	const anyRanFailed = scenarios.some((s) => s.verdict === "fail");
	const anyRanPassed = scenarios.some((s) => s.verdict === "pass");
	const overall: VoiceWorkbenchVerdict = anyRanFailed
		? "fail"
		: anyRanPassed
			? "pass"
			: "skipped";

	return {
		schemaVersion: 1,
		overall,
		scenariosTotal: runs.length,
		scenariosRan: ran.length,
		scenariosSkipped: runs.length - ran.length,
		scenarios,
		metrics: {
			wer: rollupMax(wer),
			eotFalseTriggerRate: rollupMax(ftr),
			eotLatencyP50Ms: percentile(eotLatencyP50, 50),
			eotLatencyP95Ms: percentile(eotLatencyP95, 95),
			der: rollupMax(der),
			respondAccuracy: rollupMin(respondAccuracy),
			entityF1: rollupMin(entityF1),
			voiceEntityMatchRate: rollupMin(voiceEntityMatchRate),
			firstAudioMs: rollupMax(firstAudioMs),
			echoRejectionRate: rollupMin(echoRejectionRate),
			ownerAccuracy: rollupMin(ownerAccuracy),
			impostorAcceptRate: rollupMax(impostorAcceptRate),
			bargeInGatingAccuracy: rollupMin(bargeInGatingAccuracy),
			bargeInCancelMs: rollupMax(bargeInCancelMs),
			erleDb: rollupMin(erleDb),
			partialRetractions: rollupMax(partialRetractions),
		},
	};
}

function fmt(n: number | null): string {
	return n === null ? "—" : String(n);
}

/** Render a workbench report as Markdown (one metric table + a scenario table). */
export function formatVoiceWorkbenchMarkdown(
	report: VoiceWorkbenchReport,
): string {
	const m = report.metrics;
	const lines = [
		"# Voice Workbench report",
		"",
		`**Overall:** ${report.overall.toUpperCase()} — ${report.scenariosRan} ran, ${report.scenariosSkipped} skipped of ${report.scenariosTotal}`,
		"",
		"## Metrics",
		"",
		"| Metric | Mean | Worst | n |",
		"| --- | --- | --- | --- |",
		`| WER | ${fmt(m.wer.mean)} | ${fmt(m.wer.worst)} | ${m.wer.count} |`,
		`| EOT false-trigger rate | ${fmt(m.eotFalseTriggerRate.mean)} | ${fmt(m.eotFalseTriggerRate.worst)} | ${m.eotFalseTriggerRate.count} |`,
		`| EOT latency p50 (ms) | ${fmt(m.eotLatencyP50Ms)} | | |`,
		`| EOT latency p95 (ms) | ${fmt(m.eotLatencyP95Ms)} | | |`,
		`| Diarization DER | ${fmt(m.der.mean)} | ${fmt(m.der.worst)} | ${m.der.count} |`,
		`| Respond accuracy | ${fmt(m.respondAccuracy.mean)} | ${fmt(m.respondAccuracy.worst)} | ${m.respondAccuracy.count} |`,
		`| Entity F1 | ${fmt(m.entityF1.mean)} | ${fmt(m.entityF1.worst)} | ${m.entityF1.count} |`,
		`| Voice→entity match | ${fmt(m.voiceEntityMatchRate.mean)} | ${fmt(m.voiceEntityMatchRate.worst)} | ${m.voiceEntityMatchRate.count} |`,
		`| First-audio (ms) | ${fmt(m.firstAudioMs.mean)} | ${fmt(m.firstAudioMs.worst)} | ${m.firstAudioMs.count} |`,
		`| Echo rejection rate | ${fmt(m.echoRejectionRate.mean)} | ${fmt(m.echoRejectionRate.worst)} | ${m.echoRejectionRate.count} |`,
		`| Owner accuracy | ${fmt(m.ownerAccuracy.mean)} | ${fmt(m.ownerAccuracy.worst)} | ${m.ownerAccuracy.count} |`,
		`| Impostor-accept rate | ${fmt(m.impostorAcceptRate.mean)} | ${fmt(m.impostorAcceptRate.worst)} | ${m.impostorAcceptRate.count} |`,
		`| Barge-in gating accuracy | ${fmt(m.bargeInGatingAccuracy.mean)} | ${fmt(m.bargeInGatingAccuracy.worst)} | ${m.bargeInGatingAccuracy.count} |`,
		`| Barge-in cancel (ms) | ${fmt(m.bargeInCancelMs.mean)} | ${fmt(m.bargeInCancelMs.worst)} | ${m.bargeInCancelMs.count} |`,
		`| ERLE (dB) | ${fmt(m.erleDb.mean)} | ${fmt(m.erleDb.worst)} | ${m.erleDb.count} |`,
		`| Partial retractions | ${fmt(m.partialRetractions.mean)} | ${fmt(m.partialRetractions.worst)} | ${m.partialRetractions.count} |`,
		"",
		"## Scenarios",
		"",
		"| Scenario | Classes | Verdict | Cases | Failed |",
		"| --- | --- | --- | --- | --- |",
	];
	for (const s of report.scenarios) {
		const failed =
			s.failedCaseKinds.length > 0 ? s.failedCaseKinds.join(", ") : "—";
		const skip = s.skipReason ? ` (${s.skipReason})` : "";
		lines.push(
			`| ${s.scenarioId} | ${s.classes.join(", ")} | ${s.verdict}${skip} | ${s.caseCount} | ${failed} |`,
		);
	}
	return lines.join("\n");
}

export interface MetricRegression {
	metric: string;
	baseline: number;
	current: number;
	delta: number;
}

/**
 * Compare two reports and flag metrics that regressed beyond `tolerance`.
 * "Lower is better" metrics (WER, EOT FTR, DER, latencies) regress when they
 * rise; "higher is better" metrics (accuracies, F1, match rate) regress when
 * they fall. Only metrics present (non-null mean) in both reports are compared.
 */
export function regressionsAgainstBaseline(
	current: VoiceWorkbenchReport,
	baseline: VoiceWorkbenchReport,
	tolerance = 0.02,
): MetricRegression[] {
	const lowerBetter: Array<[string, number | null, number | null]> = [
		["wer", current.metrics.wer.mean, baseline.metrics.wer.mean],
		[
			"eotFalseTriggerRate",
			current.metrics.eotFalseTriggerRate.mean,
			baseline.metrics.eotFalseTriggerRate.mean,
		],
		[
			"eotLatencyP95Ms",
			current.metrics.eotLatencyP95Ms,
			baseline.metrics.eotLatencyP95Ms,
		],
		["der", current.metrics.der.mean, baseline.metrics.der.mean],
		[
			"firstAudioMs",
			current.metrics.firstAudioMs.mean,
			baseline.metrics.firstAudioMs.mean,
		],
		[
			"impostorAcceptRate",
			current.metrics.impostorAcceptRate.mean,
			baseline.metrics.impostorAcceptRate.mean,
		],
		[
			"bargeInCancelMs",
			current.metrics.bargeInCancelMs.mean,
			baseline.metrics.bargeInCancelMs.mean,
		],
		[
			"partialRetractions",
			current.metrics.partialRetractions.mean,
			baseline.metrics.partialRetractions.mean,
		],
	];
	const higherBetter: Array<[string, number | null, number | null]> = [
		[
			"respondAccuracy",
			current.metrics.respondAccuracy.mean,
			baseline.metrics.respondAccuracy.mean,
		],
		["entityF1", current.metrics.entityF1.mean, baseline.metrics.entityF1.mean],
		[
			"voiceEntityMatchRate",
			current.metrics.voiceEntityMatchRate.mean,
			baseline.metrics.voiceEntityMatchRate.mean,
		],
		[
			"echoRejectionRate",
			current.metrics.echoRejectionRate.mean,
			baseline.metrics.echoRejectionRate.mean,
		],
		[
			"ownerAccuracy",
			current.metrics.ownerAccuracy.mean,
			baseline.metrics.ownerAccuracy.mean,
		],
		[
			"bargeInGatingAccuracy",
			current.metrics.bargeInGatingAccuracy.mean,
			baseline.metrics.bargeInGatingAccuracy.mean,
		],
		["erleDb", current.metrics.erleDb.mean, baseline.metrics.erleDb.mean],
	];
	const out: MetricRegression[] = [];
	for (const [metric, cur, base] of lowerBetter) {
		if (cur === null || base === null) continue;
		const delta = round4(cur - base);
		if (delta > tolerance)
			out.push({ metric, baseline: base, current: cur, delta });
	}
	for (const [metric, cur, base] of higherBetter) {
		if (cur === null || base === null) continue;
		const delta = round4(cur - base);
		if (delta < -tolerance)
			out.push({ metric, baseline: base, current: cur, delta });
	}
	return out;
}
