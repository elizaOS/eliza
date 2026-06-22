import { describe, expect, it } from "vitest";
import { generateVoiceCorpus } from "./corpus-generator";
import { buildVoiceWorkbenchReport } from "./voice-workbench-report";
import { runVoiceScenarioHeadless } from "./workbench-headless-runner";
import { realDecisionLogicServices } from "./workbench-logic-services";
import { VOICE_WORKBENCH_SCENARIOS } from "./workbench-scenarios";

describe("realDecisionLogicServices over the built-in scenario matrix", () => {
	it("every built-in scenario PASSES against the real decision logic", async () => {
		const services = realDecisionLogicServices();
		const runs = [];
		for (const scenario of VOICE_WORKBENCH_SCENARIOS) {
			const corpus = await generateVoiceCorpus(scenario);
			runs.push(await runVoiceScenarioHeadless({ scenario, corpus, services }));
		}
		const report = buildVoiceWorkbenchReport(runs);
		const failures = report.scenarios.filter((s) => s.verdict === "fail");
		expect(
			failures,
			`failing scenarios: ${JSON.stringify(failures, null, 2)}`,
		).toEqual([]);
		expect(report.overall).toBe("pass");
		expect(report.scenariosRan).toBe(VOICE_WORKBENCH_SCENARIOS.length);
	});

	it("genuinely SUPPRESSES a confident bystander (not just echoing ground truth)", async () => {
		const scenario = VOICE_WORKBENCH_SCENARIOS.find(
			(s) => s.id === "respond-vs-bystander",
		);
		if (!scenario) throw new Error("scenario missing");
		const corpus = await generateVoiceCorpus(scenario);
		const services = realDecisionLogicServices();
		const responded: boolean[] = [];
		for (const label of corpus.groundTruth.turns) {
			const obs = await services.observeTurn({
				turnIndex: label.index,
				audio: corpus.pcm.subarray(
					label.segmentStartSample,
					label.segmentEndSample,
				),
				sampleRate: corpus.sampleRate,
				label,
				groundTruth: corpus.groundTruth,
			});
			responded.push(obs.responded);
		}
		// alice (owner) → respond, bob (bystander) → silent, alice → respond.
		expect(responded).toEqual([true, false, true]);
	});

	it("genuinely REJECTS the agent's own echoed reply via word-overlap", async () => {
		const scenario = VOICE_WORKBENCH_SCENARIOS.find(
			(s) => s.id === "echo-self-trigger",
		);
		if (!scenario) throw new Error("scenario missing");
		const corpus = await generateVoiceCorpus(scenario);
		const services = realDecisionLogicServices();
		const responded: boolean[] = [];
		for (const label of corpus.groundTruth.turns) {
			const obs = await services.observeTurn({
				turnIndex: label.index,
				audio: corpus.pcm.subarray(
					label.segmentStartSample,
					label.segmentEndSample,
				),
				sampleRate: corpus.sampleRate,
				label,
				groundTruth: corpus.groundTruth,
			});
			responded.push(obs.responded);
		}
		// real reply (respond) → echoed reply (suppressed) → thanks (respond).
		expect(responded).toEqual([true, false, true]);
	});

	it("genuinely HOLDS on a mid-utterance pause (EOT gate), then commits", async () => {
		const scenario = VOICE_WORKBENCH_SCENARIOS.find(
			(s) => s.id === "pauses-midutterance",
		);
		if (!scenario) throw new Error("scenario missing");
		const corpus = await generateVoiceCorpus(scenario);
		const services = realDecisionLogicServices();
		const decided: boolean[] = [];
		const responded: boolean[] = [];
		for (const label of corpus.groundTruth.turns) {
			const obs = await services.observeTurn({
				turnIndex: label.index,
				audio: corpus.pcm.subarray(
					label.segmentStartSample,
					label.segmentEndSample,
				),
				sampleRate: corpus.sampleRate,
				label,
				groundTruth: corpus.groundTruth,
			});
			decided.push(obs.eotDecided);
			responded.push(obs.responded);
		}
		// "...schedule a meeting with" trails off → not end-of-turn, no response;
		// "Bob tomorrow at noon" completes → end-of-turn, respond.
		expect(decided).toEqual([false, true]);
		expect(responded).toEqual([false, true]);
	});

	it("resets reply state between scenarios (no cross-scenario echo leak)", async () => {
		const services = realDecisionLogicServices();
		const echo = VOICE_WORKBENCH_SCENARIOS.find(
			(s) => s.id === "echo-self-trigger",
		);
		const greeting = VOICE_WORKBENCH_SCENARIOS.find(
			(s) => s.id === "multi-voice-greeting",
		);
		if (!echo || !greeting) throw new Error("scenarios missing");
		// Run echo scenario first (populates lastAgentReply), then greeting.
		for (const scenario of [echo, greeting]) {
			const corpus = await generateVoiceCorpus(scenario);
			for (const label of corpus.groundTruth.turns) {
				await services.observeTurn({
					turnIndex: label.index,
					audio: corpus.pcm.subarray(
						label.segmentStartSample,
						label.segmentEndSample,
					),
					sampleRate: corpus.sampleRate,
					label,
					groundTruth: corpus.groundTruth,
				});
			}
		}
		// Greeting's first turn must still be answered (no stale reply suppressing it).
		const corpus = await generateVoiceCorpus(greeting);
		const first = corpus.groundTruth.turns[0];
		const obs = await services.observeTurn({
			turnIndex: 0,
			audio: corpus.pcm.subarray(
				first.segmentStartSample,
				first.segmentEndSample,
			),
			sampleRate: corpus.sampleRate,
			label: first,
			groundTruth: corpus.groundTruth,
		});
		expect(obs.responded).toBe(true);
	});
});
