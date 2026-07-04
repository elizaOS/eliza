/** Covers building the voice-workbench report, its markdown rendering, and baseline regression detection. Deterministic. */
import { describe, expect, it } from "vitest";
import {
	scoreBargeInGating,
	scoreDiarization,
	scoreEotDecision,
	scoreErle,
	scorePartialMonotonicity,
	scoreRespondDecision,
	scoreTtsAsrRoundTrip,
} from "./e2e-harness";
import {
	buildVoiceWorkbenchReport,
	formatVoiceWorkbenchMarkdown,
	regressionsAgainstBaseline,
	type VoiceWorkbenchScenarioRun,
} from "./voice-workbench-report";

const cleanRespond: VoiceWorkbenchScenarioRun = {
	scenarioId: "respond-basic",
	classes: ["respond-no-respond"],
	status: "ran",
	cases: [
		scoreRespondDecision([
			{ responded: true, expectRespond: true },
			{ responded: false, expectRespond: false },
		]),
	],
};

const failingDiarization: VoiceWorkbenchScenarioRun = {
	scenarioId: "diar-hard",
	classes: ["diarization", "multi-speaker"],
	status: "ran",
	cases: [
		scoreDiarization([
			{ predictedLabel: "bob", expectedLabel: "alice" },
			{ predictedLabel: null, expectedLabel: "bob" },
		]),
	],
};

const skippedEot: VoiceWorkbenchScenarioRun = {
	scenarioId: "eot-stream",
	classes: ["eot"],
	status: "skipped",
	cases: [],
	skipReason: "no eot corpus",
};

describe("buildVoiceWorkbenchReport", () => {
	it("fails overall when any ran scenario fails, and rolls up metrics", () => {
		const report = buildVoiceWorkbenchReport([
			cleanRespond,
			failingDiarization,
			skippedEot,
		]);
		expect(report.overall).toBe("fail");
		expect(report.scenariosTotal).toBe(3);
		expect(report.scenariosRan).toBe(2);
		expect(report.scenariosSkipped).toBe(1);
		// respond accuracy 1.0 rolled up; DER 1.0 rolled up.
		expect(report.metrics.respondAccuracy.mean).toBe(1);
		expect(report.metrics.der.worst).toBe(1);
		const diar = report.scenarios.find((s) => s.scenarioId === "diar-hard");
		expect(diar?.verdict).toBe("fail");
		expect(diar?.failedCaseKinds).toContain("diarization");
		const eot = report.scenarios.find((s) => s.scenarioId === "eot-stream");
		expect(eot?.verdict).toBe("skipped");
		expect(eot?.skipReason).toBe("no eot corpus");
	});

	it("is skipped overall when every scenario is skipped (honesty contract)", () => {
		const report = buildVoiceWorkbenchReport([
			skippedEot,
			{ ...skippedEot, scenarioId: "eot-2" },
		]);
		expect(report.overall).toBe("skipped");
		expect(report.scenariosRan).toBe(0);
	});

	it("passes overall when ran scenarios all pass", () => {
		const report = buildVoiceWorkbenchReport([cleanRespond]);
		expect(report.overall).toBe("pass");
	});

	it("aggregates EOT latency percentiles + WER worst-as-max", () => {
		const report = buildVoiceWorkbenchReport([
			{
				scenarioId: "wer-eot",
				classes: ["eot", "multi-voice"],
				status: "ran",
				cases: [
					scoreTtsAsrRoundTrip({
						referenceText: "the quick brown fox",
						hypothesisText: "the quick brown fox",
					}),
					scoreTtsAsrRoundTrip({
						referenceText: "hello there",
						hypothesisText: "hello world",
						maxWer: 1,
					}),
					scoreEotDecision([
						{ decided: true, expected: true, latencyMs: 80 },
						{ decided: true, expected: true, latencyMs: 200 },
					]),
				],
			},
		]);
		expect(report.metrics.wer.count).toBe(2);
		expect(report.metrics.wer.worst).toBe(0.5); // 1 sub / 2 ref words
		expect(report.metrics.eotLatencyP50Ms).not.toBeNull();
		expect(report.metrics.eotLatencyP95Ms).toBe(200);
	});

	it("rolls up barge-in gating, ERLE, and partial-retraction metrics", () => {
		const report = buildVoiceWorkbenchReport([
			{
				scenarioId: "barge-erle-partials",
				classes: [
					"speaker-gated-barge-in",
					"desktop-aec",
					"streaming-partials",
				],
				status: "ran",
				cases: [
					scoreBargeInGating([
						{ expectCancel: true, cancelMs: 120 },
						{ expectCancel: false, cancelMs: null },
					]),
					scoreErle([{ erleDb: 22 }, { erleDb: 19 }], { minErleDb: 18 }),
					scorePartialMonotonicity(["a", "a b", "a b c"]),
				],
			},
		]);
		expect(report.metrics.bargeInGatingAccuracy.worst).toBe(1);
		expect(report.metrics.bargeInCancelMs.worst).toBe(120);
		expect(report.metrics.erleDb.worst).toBe(19);
		expect(report.metrics.partialRetractions.worst).toBe(0);
	});
});

describe("formatVoiceWorkbenchMarkdown", () => {
	it("renders an overall line + metric and scenario tables", () => {
		const md = formatVoiceWorkbenchMarkdown(
			buildVoiceWorkbenchReport([cleanRespond, failingDiarization, skippedEot]),
		);
		expect(md).toContain("# Voice Workbench report");
		expect(md).toContain("**Overall:** FAIL");
		expect(md).toContain("| WER |");
		expect(md).toContain("respond-basic");
		expect(md).toContain("no eot corpus");
	});
});

describe("regressionsAgainstBaseline", () => {
	it("flags a higher-is-better metric that dropped and a lower-is-better metric that rose", () => {
		const baseline = buildVoiceWorkbenchReport([
			{
				scenarioId: "s",
				classes: ["respond-no-respond"],
				status: "ran",
				cases: [
					scoreRespondDecision([
						{ responded: true, expectRespond: true },
						{ responded: false, expectRespond: false },
					]),
					scoreDiarization([{ predictedLabel: "a", expectedLabel: "a" }]),
				],
			},
		]);
		const current = buildVoiceWorkbenchReport([
			{
				scenarioId: "s",
				classes: ["respond-no-respond"],
				status: "ran",
				cases: [
					scoreRespondDecision([
						{ responded: true, expectRespond: false }, // accuracy drops to 0
						{ responded: false, expectRespond: false },
					]),
					scoreDiarization([
						{ predictedLabel: "b", expectedLabel: "a" }, // DER rises to 1
					]),
				],
			},
		]);
		const regs = regressionsAgainstBaseline(current, baseline);
		const metrics = regs.map((r) => r.metric);
		expect(metrics).toContain("respondAccuracy");
		expect(metrics).toContain("der");
	});

	it("returns nothing when metrics are stable", () => {
		const report = buildVoiceWorkbenchReport([cleanRespond]);
		expect(regressionsAgainstBaseline(report, report)).toHaveLength(0);
	});

	it("flags an ERLE drop and a barge-in cancel-latency rise past tolerance", () => {
		const make = (
			erle: number,
			cancelMs: number,
		): VoiceWorkbenchScenarioRun => ({
			scenarioId: "aec",
			classes: ["desktop-aec", "speaker-gated-barge-in"],
			status: "ran",
			cases: [
				scoreErle([{ erleDb: erle }], { minErleDb: 18 }),
				scoreBargeInGating([{ expectCancel: true, cancelMs }]),
			],
		});
		const regs = regressionsAgainstBaseline(
			buildVoiceWorkbenchReport([make(20, 120)]),
			buildVoiceWorkbenchReport([make(28, 100)]),
		);
		const metrics = regs.map((r) => r.metric);
		expect(metrics).toContain("erleDb");
		expect(metrics).toContain("bargeInCancelMs");
	});
});
