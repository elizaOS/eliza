/** Covers building the voice-workbench report, its markdown rendering, and baseline regression detection. Deterministic. */
import { describe, expect, it } from "vitest";
import {
	scoreBargeInGating,
	scoreDiarization,
	scoreDiarizationSegments,
	scoreEotDecision,
	scoreErle,
	scoreMeasurementCoverage,
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

	it("publishes per-scenario real measurement counts and failures", () => {
		const report = buildVoiceWorkbenchReport([
			{
				scenarioId: "coverage",
				classes: ["endpoint-latency"],
				status: "ran",
				cases: [
					scoreMeasurementCoverage("first-audio-latency", 0),
					scoreMeasurementCoverage("diarization-segments", 3),
				],
			},
		]);
		expect(report.scenarios[0].measurementCoverage).toEqual([
			{ metric: "first-audio-latency", count: 0, passed: false },
			{ metric: "diarization-segments", count: 3, passed: true },
		]);
		expect(formatVoiceWorkbenchMarkdown(report)).toContain(
			"first-audio-latency=0!",
		);
	});

	it("publishes transcript-free turn identity and DER failure evidence additively", () => {
		const report = buildVoiceWorkbenchReport([
			{
				scenarioId: "identity-diagnostics",
				classes: ["diarization", "voice-recognition", "owner-security"],
				status: "ran",
				cases: [
					scoreTtsAsrRoundTrip({
						referenceText: "fixture utterance must remain redacted",
						hypothesisText: "different words",
						maxWer: 0.1,
					}),
					scoreDiarizationSegments(
						[
							{ speaker: "alice", startMs: 0, endMs: 1000 },
							{ speaker: "bob", startMs: 1000, endMs: 2000 },
						],
						[{ speaker: "cluster-one", startMs: 0, endMs: 2000 }],
						{ maxDer: 0.2 },
					),
				],
				turnEvidence: [
					{
						turnIndex: 0,
						expectedSpeakerLabel: "alice",
						predictedSpeakerLabel: "bob",
						expectedEntityId: "entity-alice",
						matchedEntityId: "entity-bob",
						expectedOwner: true,
						predictedOwner: false,
						expectRespond: true,
						responded: true,
						synthesizedVoiceId: "af_bella",
						speakerSimilarity: 0.61,
						speakerAcceptThreshold: 0.78,
					},
				],
			},
		]);

		expect(report.schemaVersion).toBe(1);
		expect(report.scenarios[0].turnEvidence?.[0]).toMatchObject({
			synthesizedVoiceId: "af_bella",
			expectedEntityId: "entity-alice",
			matchedEntityId: "entity-bob",
		});
		const serialized = JSON.stringify(report);
		expect(serialized).not.toContain("fixture utterance");
		expect(serialized).not.toContain("different words");
		const diarization = report.scenarios[0].failedCaseEvidence?.find(
			(entry) => entry.kind === "diarization",
		);
		expect(diarization).toMatchObject({
			der: 0.5,
			mapping: { "cluster-one": "alice" },
		});
		const markdown = formatVoiceWorkbenchMarkdown(report);
		expect(markdown).toContain("## Diarization failure evidence");
		expect(markdown).toContain("cluster-one→alice");
		expect(markdown).toContain("## Identity mismatch evidence");
		expect(markdown).not.toContain("fixture utterance");
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
