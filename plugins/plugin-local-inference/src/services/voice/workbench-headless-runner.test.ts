import { describe, expect, it } from "vitest";
import { generateVoiceCorpus } from "./corpus-generator";
import type { VoiceScenario } from "./voice-scenario";
import { buildVoiceWorkbenchReport } from "./voice-workbench-report";
import {
	runVoiceScenarioHeadless,
	runVoiceWorkbenchHeadless,
	type VoiceWorkbenchServices,
} from "./workbench-headless-runner";
import {
	groundTruthMockServices,
	VOICE_WORKBENCH_SCENARIOS,
} from "./workbench-scenarios";

const SCENARIO: VoiceScenario = {
	id: "runner-demo",
	classes: ["multi-speaker", "respond-no-respond", "voice-recognition"],
	participants: [
		{ label: "alice", entityId: "entity-alice" },
		{ label: "bob", entityId: "entity-bob" },
	],
	turns: [
		{ speaker: "alice", text: "Eliza what time is it", expectRespond: true },
		{ speaker: "bob", text: "hey alice not you", expectRespond: false },
	],
	assertions: { maxWer: 0.2, maxDer: 0.2, minRespondAccuracy: 0.9 },
};

describe("runVoiceScenarioHeadless — honesty contract", () => {
	it("skips (never passes) when the backend is absent", async () => {
		const corpus = await generateVoiceCorpus(SCENARIO);
		const run = await runVoiceScenarioHeadless({
			scenario: SCENARIO,
			corpus,
			services: null,
		});
		expect(run.status).toBe("skipped");
		expect(run.cases).toHaveLength(0);
		expect(run.skipReason).toMatch(/no voice backend/);
	});

	it("skips when the corpus is absent", async () => {
		const run = await runVoiceScenarioHeadless({
			scenario: SCENARIO,
			corpus: null,
			services: groundTruthMockServices(),
		});
		expect(run.status).toBe("skipped");
		expect(run.skipReason).toMatch(/corpus/);
	});
});

describe("runVoiceScenarioHeadless — scoring", () => {
	it("a ground-truth-perfect backend passes every scorer", async () => {
		const corpus = await generateVoiceCorpus(SCENARIO);
		const run = await runVoiceScenarioHeadless({
			scenario: SCENARIO,
			corpus,
			services: groundTruthMockServices(),
		});
		expect(run.status).toBe("ran");
		expect(run.cases.every((c) => c.passed)).toBe(true);
		const kinds = new Set(run.cases.map((c) => c.kind));
		expect(kinds.has("tts-asr-roundtrip")).toBe(true);
		expect(kinds.has("eot-decision")).toBe(true);
		expect(kinds.has("diarization")).toBe(true);
		expect(kinds.has("respond-decision")).toBe(true);
		expect(kinds.has("voice-entity-match")).toBe(true);
	});

	it("a faulty backend fails the scorers it regressed", async () => {
		const corpus = await generateVoiceCorpus(SCENARIO);
		// Diarization always says "alice" + the agent always responds.
		const faulty: VoiceWorkbenchServices = {
			async observeTurn({ label }) {
				return {
					hypothesisTranscript: label.referenceTranscript,
					predictedSpeakerLabel: "alice", // wrong for bob's turn
					eotDecided: true,
					responded: true, // wrong for the bystander turn
					inferredEntities: [],
					matchedEntityId: label.entityId ?? null,
				};
			},
		};
		const run = await runVoiceScenarioHeadless({
			scenario: SCENARIO,
			corpus,
			services: faulty,
		});
		expect(run.status).toBe("ran");
		const failed = new Set(
			run.cases.filter((c) => !c.passed).map((c) => c.kind),
		);
		expect(failed.has("diarization")).toBe(true);
		expect(failed.has("respond-decision")).toBe(true);
	});

	it("fails EOT when a mid-utterance pause is treated as a boundary", async () => {
		const scenario = VOICE_WORKBENCH_SCENARIOS.find(
			(candidate) => candidate.id === "pauses-midutterance",
		);
		if (!scenario) throw new Error("missing pauses-midutterance scenario");
		const corpus = await generateVoiceCorpus(scenario);
		const eagerEot: VoiceWorkbenchServices = {
			async observeTurn({ label }) {
				return {
					hypothesisTranscript: label.referenceTranscript,
					predictedSpeakerLabel: label.speaker,
					eotDecided: true,
					responded: label.expectRespond,
					inferredEntities: [],
					matchedEntityId: label.entityId ?? null,
				};
			},
		};

		const run = await runVoiceScenarioHeadless({
			scenario,
			corpus,
			services: eagerEot,
		});
		const eot = run.cases.find((c) => c.kind === "eot-decision");
		expect(eot?.passed).toBe(false);
		expect(eot).toMatchObject({ falseTriggerRate: 0.5 });
	});
});

describe("runVoiceWorkbenchHeadless over the built-in scenario matrix", () => {
	it("the ground-truth mock lane produces an overall PASS report", async () => {
		const entries = await Promise.all(
			VOICE_WORKBENCH_SCENARIOS.map(async (scenario) => ({
				scenario,
				corpus: await generateVoiceCorpus(scenario),
			})),
		);
		const runs = await runVoiceWorkbenchHeadless({
			scenarios: entries,
			services: groundTruthMockServices(),
		});
		const report = buildVoiceWorkbenchReport(runs);
		expect(report.overall).toBe("pass");
		expect(report.scenariosRan).toBe(VOICE_WORKBENCH_SCENARIOS.length);
		expect(report.scenariosSkipped).toBe(0);
	});

	it("an absent backend skips the whole matrix (overall skipped, never pass)", async () => {
		const entries = await Promise.all(
			VOICE_WORKBENCH_SCENARIOS.map(async (scenario) => ({
				scenario,
				corpus: await generateVoiceCorpus(scenario),
			})),
		);
		const runs = await runVoiceWorkbenchHeadless({
			scenarios: entries,
			services: null,
		});
		const report = buildVoiceWorkbenchReport(runs);
		expect(report.overall).toBe("skipped");
		expect(report.scenariosRan).toBe(0);
	});
});
