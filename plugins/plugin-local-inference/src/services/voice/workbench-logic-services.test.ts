/** Covers `realDecisionLogicServices` across the built-in scenario matrix. Deterministic. */
import { describe, expect, it } from "vitest";
import { generateVoiceCorpus } from "./corpus-generator";
import type { VoiceScenario } from "./voice-scenario";
import { buildVoiceWorkbenchReport } from "./voice-workbench-report";
import {
	runVoiceScenarioHeadless,
	type VoiceWorkbenchServices,
} from "./workbench-headless-runner";
import { realDecisionLogicServices } from "./workbench-logic-services";
import { VOICE_WORKBENCH_SCENARIOS } from "./workbench-scenarios";

/** Plain Levenshtein distance — powers the simulated fuzzy-matcher regression. */
function editDistance(a: string, b: string): number {
	const rows = a.length + 1;
	const cols = b.length + 1;
	const d: number[] = Array.from({ length: cols }, (_, j) => j);
	for (let i = 1; i < rows; i += 1) {
		let prevDiag = d[0];
		d[0] = i;
		for (let j = 1; j < cols; j += 1) {
			const cur = d[j];
			d[j] = Math.min(
				d[j] + 1,
				d[j - 1] + 1,
				prevDiag + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
			prevDiag = cur;
		}
	}
	return d[cols - 1];
}

describe("realDecisionLogicServices over the built-in scenario matrix", () => {
	// Generous timeout: the matrix synthesizes + blind-FFT-clusters every scenario,
	// including the ~30 s long-turn-diarization corpus, so it runs well past the
	// default 5 s (especially on the slower CI runner).
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
	}, 60_000);

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

	it("binds each confusable name to exactly its own entity — clean AND noisy (#10726)", async () => {
		// Jon/John/Joan (clean) and Erik/Erika + Mia/Maya (10 dB pink noise +
		// reverb): exact-name binding must resolve every introduction to its own
		// entity. minEntityF1 is pinned to 1, so ONE cross-bind (precision) or one
		// confusable collapse (recall) fails the scenario.
		const services = realDecisionLogicServices();
		for (const id of ["confusable-names-clean", "confusable-names-noisy"]) {
			const scenario = VOICE_WORKBENCH_SCENARIOS.find((s) => s.id === id);
			if (!scenario) throw new Error(`scenario ${id} missing`);
			const corpus = await generateVoiceCorpus(scenario);
			const run = await runVoiceScenarioHeadless({
				scenario,
				corpus,
				services,
			});
			const entity = run.cases.find((c) => c.kind === "entity-extraction");
			expect(entity, `${id} scores entity extraction`).toMatchObject({
				precision: 1,
				recall: 1,
				f1: 1,
				minF1: 1,
				passed: true,
			});
			const match = run.cases.find((c) => c.kind === "voice-entity-match");
			expect(match, `${id} voice→entity match`).toMatchObject({
				matchRate: 1,
				passed: true,
			});
			const diar = run.cases.find((c) => c.kind === "diarization");
			expect(diar?.passed, `${id} diarization gate`).toBe(true);
		}
	});

	it("a garbled confusable name ('Maia' between Mia and Maya) binds NOTHING", async () => {
		// ASR heard "Maia" — ambiguous between two enrolled confusables. The
		// extractor must not guess a near-miss neighbor: only Pam's clean
		// introduction is inferred, and the gate still scores a perfect F1.
		const scenario = VOICE_WORKBENCH_SCENARIOS.find(
			(s) => s.id === "confusable-name-garbled-transcript",
		);
		if (!scenario) throw new Error("scenario missing");
		const corpus = await generateVoiceCorpus(scenario);
		const services = realDecisionLogicServices();
		const inferred: string[][] = [];
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
			inferred.push(obs.inferredEntities);
		}
		// pam introduces herself; garbled "Maia" binds nothing; maya's turn has
		// no name claim.
		expect(inferred).toEqual([["entity-pam"], [], []]);

		const run = await runVoiceScenarioHeadless({
			scenario,
			corpus,
			services: realDecisionLogicServices(),
		});
		expect(run.cases.find((c) => c.kind === "entity-extraction")).toMatchObject(
			{ precision: 1, recall: 1, f1: 1, passed: true },
		);
	});

	it("the disambiguation gate FAILS a fuzzy near-miss matcher — not a tautology (#10726)", async () => {
		// Simulate the regression the scenario exists to catch: a name binder
		// that accepts an edit-distance-1 neighbor. "maia" is 1 edit from BOTH
		// "mia" and "maya", so the fuzzy binder guesses one — an unexpected
		// inferred entity → precision 0.5 → F1 0.6667 < minEntityF1 1 → FAIL.
		const scenario = VOICE_WORKBENCH_SCENARIOS.find(
			(s) => s.id === "confusable-name-garbled-transcript",
		);
		if (!scenario) throw new Error("scenario missing");
		const corpus = await generateVoiceCorpus(scenario);
		const fuzzy: VoiceWorkbenchServices = {
			async observeTurn({ label, groundTruth }) {
				const m = label.referenceTranscript.match(/\bi am\s+([a-z]+)/i);
				const name = m?.[1]?.toLowerCase() ?? null;
				const inferredEntities: string[] = [];
				if (name) {
					const near = groundTruth.participants.find(
						(p) => p.entityId && editDistance(p.label.toLowerCase(), name) <= 1,
					);
					if (near?.entityId) inferredEntities.push(near.entityId);
				}
				return {
					hypothesisTranscript: label.referenceTranscript,
					predictedSpeakerLabel: label.speaker,
					eotDecided: true,
					responded: label.expectRespond,
					inferredEntities,
					matchedEntityId: label.entityId ?? null,
				};
			},
		};
		const run = await runVoiceScenarioHeadless({
			scenario,
			corpus,
			services: fuzzy,
		});
		const entity = run.cases.find((c) => c.kind === "entity-extraction");
		expect(entity).toMatchObject({ precision: 0.5, passed: false });
	});

	it("the disambiguation gate FAILS a collapse-to-one-name matcher on Jon/John/Joan", async () => {
		// The other regression direction: every j-name collapses onto the first
		// same-initial participant → recall 1/3 → F1 0.5 < minEntityF1 1 → FAIL.
		const scenario = VOICE_WORKBENCH_SCENARIOS.find(
			(s) => s.id === "confusable-names-clean",
		);
		if (!scenario) throw new Error("scenario missing");
		const corpus = await generateVoiceCorpus(scenario);
		const collapsing: VoiceWorkbenchServices = {
			async observeTurn({ label, groundTruth }) {
				const m = label.referenceTranscript.match(/\bi am\s+([a-z]+)/i);
				const name = m?.[1]?.toLowerCase() ?? null;
				const inferredEntities: string[] = [];
				if (name) {
					const near = groundTruth.participants.find(
						(p) => p.entityId && p.label.toLowerCase()[0] === name[0],
					);
					if (near?.entityId) inferredEntities.push(near.entityId);
				}
				return {
					hypothesisTranscript: label.referenceTranscript,
					predictedSpeakerLabel: label.speaker,
					eotDecided: true,
					responded: label.expectRespond,
					inferredEntities,
					matchedEntityId: label.entityId ?? null,
				};
			},
		};
		const run = await runVoiceScenarioHeadless({
			scenario,
			corpus,
			services: collapsing,
		});
		const entity = run.cases.find((c) => c.kind === "entity-extraction");
		expect(entity).toMatchObject({ recall: 0.3333, f1: 0.5, passed: false });
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
