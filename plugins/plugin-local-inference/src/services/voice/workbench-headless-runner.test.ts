/** Covers the headless voice-scenario runner: honesty contract, scoring, and audio-capture sink (#8934). Deterministic. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateVoiceCorpus } from "./corpus-generator";
import type { VoiceScenario } from "./voice-scenario";
import { buildVoiceWorkbenchReport } from "./voice-workbench-report";
import { decodeMonoPcm16Wav } from "./wav-codec";
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

describe("runVoiceScenarioHeadless — audio capture sink (#8934)", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	function makeRunDir(): string {
		const dir = mkdtempSync(path.join(tmpdir(), "voice-capture-"));
		tempDirs.push(dir);
		return dir;
	}

	it("writes corpus.wav + per-turn turn-<n>.wav and records run-dir-relative artifacts", async () => {
		const corpus = await generateVoiceCorpus(SCENARIO);
		const runDir = makeRunDir();
		const audioDir = path.join(runDir, "audio", SCENARIO.id);

		const run = await runVoiceScenarioHeadless({
			scenario: SCENARIO,
			corpus,
			services: groundTruthMockServices(),
			captureAudio: { dir: audioDir, relativeTo: runDir },
		});

		expect(run.status).toBe("ran");
		const labels = corpus.groundTruth.turns;
		const artifacts = run.audioArtifacts ?? [];
		// The full synthesized corpus once + one consumed slice per corpus turn.
		expect(artifacts).toHaveLength(1 + labels.length);

		const generated = artifacts.filter((a) => a.kind === "generated");
		const consumed = artifacts.filter((a) => a.kind === "consumed");
		expect(generated).toHaveLength(1);
		expect(consumed).toHaveLength(labels.length);

		// (c) `generated` is the whole corpus at turn 0, path is run-dir-relative.
		expect(generated[0].path).toBe(`audio/${SCENARIO.id}/corpus.wav`);
		expect(generated[0].turnIndex).toBe(0);
		expect(generated[0].sampleRate).toBe(corpus.sampleRate);

		// (c) `consumed` per-turn slices carry the ground-truth speaker + index.
		consumed.forEach((artifact, i) => {
			expect(artifact.path).toBe(
				`audio/${SCENARIO.id}/turn-${labels[i].index}.wav`,
			);
			expect(artifact.turnIndex).toBe(labels[i].index);
			expect(artifact.speakerLabel).toBe(labels[i].speaker);
		});

		for (const artifact of artifacts) {
			const absolute = path.join(runDir, artifact.path);
			// (a) the file is actually on disk under the run dir.
			expect(existsSync(absolute)).toBe(true);
			const bytes = new Uint8Array(readFileSync(absolute));
			// (b) raw RIFF/WAVE magic in the header.
			expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("RIFF");
			expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe("WAVE");
			// (b) the decoder enforces PCM16 mono (format=1 channels=1 bits=16) —
			// it throws on any other shape, so a successful decode IS the assertion.
			const decoded = decodeMonoPcm16Wav(bytes);
			expect(decoded.sampleRate).toBe(corpus.sampleRate);
			expect(decoded.pcm.length).toBeGreaterThan(0);
			// The recorded durationMs matches the decoded sample count.
			expect(artifact.durationMs).toBe(
				Math.round((decoded.pcm.length / decoded.sampleRate) * 1000),
			);
		}

		// The generated corpus.wav round-trips back to the full corpus length.
		const corpusBytes = new Uint8Array(
			readFileSync(path.join(runDir, generated[0].path)),
		);
		expect(decodeMonoPcm16Wav(corpusBytes).pcm.length).toBe(corpus.pcm.length);
	});

	it("writes nothing and records no artifacts when no capture sink is given", async () => {
		const corpus = await generateVoiceCorpus(SCENARIO);
		const runDir = makeRunDir();

		const run = await runVoiceScenarioHeadless({
			scenario: SCENARIO,
			corpus,
			services: groundTruthMockServices(),
		});

		expect(run.status).toBe("ran");
		expect(run.audioArtifacts).toBeUndefined();
		// No capture sink ⇒ zero audio IO into the run dir.
		expect(existsSync(path.join(runDir, "audio"))).toBe(false);
	});
});

describe("runVoiceScenarioHeadless — speaker-gated barge-in / ERLE / partials", () => {
	function scenario(id: string): VoiceScenario {
		const found = VOICE_WORKBENCH_SCENARIOS.find((s) => s.id === id);
		if (!found) throw new Error(`missing scenario ${id}`);
		return found;
	}

	it("fails barge-in gating when the agent's own echo hard-stops it", async () => {
		const s = scenario("speaker-gated-barge-in");
		const corpus = await generateVoiceCorpus(s);
		// A backend that cancels TTS on EVERY barge-in — including the echo and the
		// bystander — is exactly the speaker-gating regression the gate must catch.
		const overEager: VoiceWorkbenchServices = {
			async observeTurn({ label }) {
				return {
					hypothesisTranscript: label.referenceTranscript,
					predictedSpeakerLabel: label.speaker,
					eotDecided: true,
					responded: label.expectRespond,
					inferredEntities: [],
					matchedEntityId: label.entityId ?? null,
					...(label.bargeIn ? { bargeInCancelMs: 90 } : {}),
				};
			},
		};
		const run = await runVoiceScenarioHeadless({
			scenario: s,
			corpus,
			services: overEager,
		});
		const gating = run.cases.find((c) => c.kind === "barge-in-gating");
		expect(gating?.passed).toBe(false);
		if (gating?.kind === "barge-in-gating") expect(gating.wrongCancels).toBe(2);
	});

	it("scores ERLE + echo rejection on the desktop-AEC scenario (mock lane)", async () => {
		const s = scenario("desktop-aec-echo");
		const corpus = await generateVoiceCorpus(s);
		const run = await runVoiceScenarioHeadless({
			scenario: s,
			corpus,
			services: groundTruthMockServices(),
		});
		const kinds = new Set(run.cases.map((c) => c.kind));
		expect(kinds.has("erle")).toBe(true);
		expect(kinds.has("echo-rejection")).toBe(true);
		expect(run.cases.every((c) => c.passed)).toBe(true);
	});

	it("scores partial monotonicity only when the lane emits a partial stream", async () => {
		const s = scenario("streaming-partials-monotonic");
		const corpus = await generateVoiceCorpus(s);
		// Mock emits partials for streaming-partials scenarios → scored + passes.
		const withPartials = await runVoiceScenarioHeadless({
			scenario: s,
			corpus,
			services: groundTruthMockServices(),
		});
		expect(
			withPartials.cases.some((c) => c.kind === "partial-monotonicity"),
		).toBe(true);
		// A batch-only backend emits no partials → honestly unscored (never faked).
		const batchOnly: VoiceWorkbenchServices = {
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
			scenario: s,
			corpus,
			services: batchOnly,
		});
		expect(run.cases.some((c) => c.kind === "partial-monotonicity")).toBe(
			false,
		);
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
