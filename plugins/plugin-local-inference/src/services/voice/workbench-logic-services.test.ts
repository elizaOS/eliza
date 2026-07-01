import { describe, expect, it } from "vitest";
import { generateVoiceCorpus } from "./corpus-generator";
import type { VoiceScenario } from "./voice-scenario";
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

	it("attributes the multi-speaker scenarios from AUDIO, scoring DER 0", async () => {
		// The real diarization gate: blind acoustic clustering must partition the
		// distinct voices correctly — proving `predictedSpeakerLabel` is derived,
		// not copied from the ground-truth label (#9427).
		const services = realDecisionLogicServices();
		for (const id of ["multi-voice-greeting", "multi-speaker-name-capture"]) {
			const scenario = VOICE_WORKBENCH_SCENARIOS.find((s) => s.id === id);
			if (!scenario) throw new Error(`scenario ${id} missing`);
			const corpus = await generateVoiceCorpus(scenario);
			const run = await runVoiceScenarioHeadless({
				scenario,
				corpus,
				services,
			});
			const diar = run.cases.find((c) => c.kind === "diarization");
			expect(diar, `${id} has a diarization case`).toBeDefined();
			expect(diar?.kind === "diarization" && diar.der).toBe(0);
			expect(diar?.passed).toBe(true);
		}
	});

	it("the DER gate FAILS on a real misattribution — not a tautology (#9427)", async () => {
		// Two participants, SAME words so their speech regions are the same length.
		const scenario: VoiceScenario = {
			id: "diar-divergence-probe",
			classes: ["diarization", "multi-speaker"],
			participants: [
				{ label: "alice", entityId: "entity-alice" },
				{ label: "bob", entityId: "entity-bob" },
			],
			turns: [
				{
					speaker: "alice",
					text: "eliza what time is it now",
					expectRespond: true,
				},
				{
					speaker: "bob",
					text: "eliza what time is it now",
					expectRespond: true,
				},
			],
			assertions: { maxDer: 0.2 },
		};
		const corpus = await generateVoiceCorpus(scenario);

		// Honest: the two distinct voices cluster apart → DER 0, gate passes.
		const honest = await runVoiceScenarioHeadless({
			scenario,
			corpus,
			services: realDecisionLogicServices(),
		});
		const honestDer = honest.cases.find((c) => c.kind === "diarization");
		expect(honestDer?.der).toBe(0);
		expect(honestDer?.passed).toBe(true);

		// Tamper ONLY the audio: overwrite bob's speech with alice's voice. Ground
		// truth still labels the turns alice/bob, so a tautological gate would keep
		// passing — but the real acoustic clusterer hears one voice, merges the
		// turns, and the DER gate trips.
		const [aliceTurn, bobTurn] = corpus.groundTruth.turns;
		const tamperedPcm = corpus.pcm.slice();
		tamperedPcm.set(
			corpus.pcm.subarray(
				aliceTurn.speechStartSample,
				aliceTurn.speechEndSample,
			),
			bobTurn.speechStartSample,
		);
		const tampered = await runVoiceScenarioHeadless({
			scenario,
			corpus: { ...corpus, pcm: tamperedPcm },
			services: realDecisionLogicServices(),
		});
		const tamperedDer = tampered.cases.find((c) => c.kind === "diarization");
		expect(tamperedDer?.der).toBeGreaterThan(0.2);
		expect(tamperedDer?.passed).toBe(false);
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
