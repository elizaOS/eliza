/**
 * Exercises real end-of-turn adapters and voice state transitions with an
 * in-memory checkpoint manager and injected classifier probabilities. Shared
 * voice-eot tests own the scoring rules; this suite owns their voice consumer.
 */

import { describe, expect, it, vi } from "vitest";
import { MockCheckpointManager } from "../checkpoint-manager";
import {
	EOT_COMMIT_SILENCE_MS,
	EOT_FUSED_COMMIT_THRESHOLD,
	EOT_HANGOVER_EXTENSION_MS,
	EOT_TENTATIVE_SILENCE_MS,
	type EotClassifier,
	HeuristicEotClassifier,
	RemoteEotClassifier,
} from "../eot-classifier";
import {
	type DrafterAbortReason,
	type DrafterHandle,
	type StartDrafterFn,
	VoiceStateMachine,
} from "../voice-state-machine";

function makeDrafter(): {
	fn: StartDrafterFn;
	started: number;
	aborted: DrafterAbortReason[];
} {
	let started = 0;
	const aborted: DrafterAbortReason[] = [];
	const fn: StartDrafterFn = () => {
		started++;
		const handle: DrafterHandle = { abort: (r) => aborted.push(r) };
		return handle;
	};
	// Use a getter so started stays live.
	return {
		fn,
		get started() {
			return started;
		},
		aborted,
	};
}

function makeMachine(eotClassifier?: EotClassifier, pauseHangoverMs = 200) {
	const mock = new MockCheckpointManager();
	const drafter = makeDrafter();
	const commits: Array<{ turnId: string; transcript: string }> = [];
	const eotScores: Array<{ pDone: number }> = [];
	const machine = new VoiceStateMachine({
		slotId: "test-slot",
		checkpointManager: mock,
		startDrafter: drafter.fn,
		pauseHangoverMs,
		eotClassifier,
		events: {
			onCommit: (turnId, transcript) => commits.push({ turnId, transcript }),
			onEotScore: (_turnId, _text, pDone) => eotScores.push({ pDone }),
		},
	});
	return { machine, mock, drafter, commits, eotScores };
}

describe("HeuristicEotClassifier adapter", () => {
	it.each([
		["  Done.  ", 0.95, "agent", true],
		["  going to  ", 0.2, "user", false],
		["   ", 0.5, "unknown", null],
	] as const)(
		"emits a structured turn signal for %j",
		async (text, probability, nextSpeaker, agentShouldSpeak) => {
			expect(await new HeuristicEotClassifier().signal(text)).toEqual({
				endOfTurnProbability: probability,
				nextSpeaker,
				agentShouldSpeak,
				transcript: text.trim(),
				source: "heuristic",
				model: "heuristic-v1",
			});
		},
	);
});

describe("VoiceStateMachine — EOT classifier integration", () => {
	it("P≥0.9 AND silence≥50ms while LISTENING → commits immediately", async () => {
		// Classifier always returns commit-level probability.
		const highClf: EotClassifier = { score: async () => 0.95 };
		const { machine, commits } = makeMachine(highClf);

		await machine.dispatch({ type: "speech-start", timestampMs: 0 });
		expect(machine.getState()).toBe("LISTENING");

		await machine.dispatch({
			type: "partial-transcript",
			timestampMs: 500,
			text: "I'd like some help.",
			silenceSinceMs: EOT_COMMIT_SILENCE_MS, // exactly at threshold
		});

		// Machine should have committed (transitioned through PAUSE_TENTATIVE? No
		// — high-confidence commit path goes directly to SPEAKING via handleSpeechEnd).
		expect(machine.getState()).toBe("SPEAKING");
		expect(commits).toHaveLength(1);
		expect(commits[0].transcript).toBe("I'd like some help.");
	});

	it("P≥0.9 but silence<50ms while LISTENING → does NOT commit early", async () => {
		const highClf: EotClassifier = { score: async () => 0.95 };
		const { machine, commits } = makeMachine(highClf);

		await machine.dispatch({ type: "speech-start", timestampMs: 0 });
		await machine.dispatch({
			type: "partial-transcript",
			timestampMs: 500,
			text: "Almost done",
			silenceSinceMs: EOT_COMMIT_SILENCE_MS - 1, // just under threshold
		});

		// Not enough silence despite high P — should still be LISTENING or
		// have entered PAUSE_TENTATIVE (via tentative branch if P≥0.6 too),
		// but NOT have committed.
		expect(commits).toHaveLength(0);
	});

	it("fused classifiers commit at P≥0.7 with 50ms silence", async () => {
		const fusedClf: EotClassifier = {
			commitThreshold: EOT_FUSED_COMMIT_THRESHOLD,
			score: async () => EOT_FUSED_COMMIT_THRESHOLD,
		};
		const { machine, commits } = makeMachine(fusedClf);

		await machine.dispatch({ type: "speech-start", timestampMs: 0 });
		await machine.dispatch({
			type: "partial-transcript",
			timestampMs: 500,
			text: "That should work",
			silenceSinceMs: EOT_COMMIT_SILENCE_MS,
		});

		expect(machine.getState()).toBe("SPEAKING");
		expect(commits).toHaveLength(1);
	});

	it("heuristic-only classifiers do not commit at the fused threshold", async () => {
		const heuristicLevelClf: EotClassifier = {
			score: async () => EOT_FUSED_COMMIT_THRESHOLD,
		};
		const { machine, commits } = makeMachine(heuristicLevelClf);

		await machine.dispatch({ type: "speech-start", timestampMs: 0 });
		await machine.dispatch({
			type: "partial-transcript",
			timestampMs: 500,
			text: "That should work",
			silenceSinceMs: EOT_COMMIT_SILENCE_MS,
		});

		expect(machine.getState()).toBe("PAUSE_TENTATIVE");
		expect(commits).toHaveLength(0);
	});

	it("P≥0.6 AND silence≥20ms while LISTENING → enters PAUSE_TENTATIVE early", async () => {
		const tentativeClf: EotClassifier = { score: async () => 0.75 };
		const { machine, drafter } = makeMachine(tentativeClf);

		await machine.dispatch({ type: "speech-start", timestampMs: 0 });
		expect(machine.getState()).toBe("LISTENING");

		await machine.dispatch({
			type: "partial-transcript",
			timestampMs: 300,
			text: "I think that",
			silenceSinceMs: EOT_TENTATIVE_SILENCE_MS, // exactly at threshold
		});

		expect(machine.getState()).toBe("PAUSE_TENTATIVE");
		expect(drafter.started).toBeGreaterThanOrEqual(1);
	});

	it("P≥0.6 but silence<20ms → does NOT enter PAUSE_TENTATIVE early", async () => {
		const tentativeClf: EotClassifier = { score: async () => 0.75 };
		const { machine, drafter } = makeMachine(tentativeClf);

		await machine.dispatch({ type: "speech-start", timestampMs: 0 });
		await machine.dispatch({
			type: "partial-transcript",
			timestampMs: 300,
			text: "maybe",
			silenceSinceMs: EOT_TENTATIVE_SILENCE_MS - 1,
		});

		expect(machine.getState()).toBe("LISTENING");
		expect(drafter.started).toBe(0);
	});

	it("P<0.4 → accumulates EOT hangover extension", async () => {
		const midClauseClf: EotClassifier = { score: async () => 0.15 };
		const { machine } = makeMachine(midClauseClf);

		await machine.dispatch({ type: "speech-start", timestampMs: 0 });
		expect(machine.getEotHangoverExtensionMs()).toBe(0);

		await machine.dispatch({
			type: "partial-transcript",
			timestampMs: 200,
			text: "I was going to say something but",
			silenceSinceMs: 10,
		});

		expect(machine.getEotHangoverExtensionMs()).toBe(EOT_HANGOVER_EXTENSION_MS);
	});

	it("filler + long pause holds instead of committing", async () => {
		const clf = new HeuristicEotClassifier();
		const { machine, commits } = makeMachine(clf);

		await machine.dispatch({ type: "speech-start", timestampMs: 0 });
		await machine.dispatch({
			type: "partial-transcript",
			timestampMs: 700,
			text: "Let me think um",
			silenceSinceMs: 700,
		});

		expect(machine.getState()).toBe("LISTENING");
		expect(commits).toHaveLength(0);
		expect(machine.getEotHangoverExtensionMs()).toBe(EOT_HANGOVER_EXTENSION_MS);
	});

	it("mid-clause pause ≥700ms holds instead of committing", async () => {
		const clf = new HeuristicEotClassifier();
		const { machine, commits } = makeMachine(clf);

		await machine.dispatch({ type: "speech-start", timestampMs: 0 });
		await machine.dispatch({
			type: "partial-transcript",
			timestampMs: 900,
			text: "I was thinking we could",
			silenceSinceMs: 900,
		});

		expect(machine.getState()).toBe("LISTENING");
		expect(commits).toHaveLength(0);
		expect(machine.getEotHangoverExtensionMs()).toBe(EOT_HANGOVER_EXTENSION_MS);
	});

	it("genuine sentence-final pause still commits within budget", async () => {
		const clf = new HeuristicEotClassifier();
		const { machine, commits } = makeMachine(clf);

		await machine.dispatch({ type: "speech-start", timestampMs: 0 });
		await machine.dispatch({
			type: "partial-transcript",
			timestampMs: 80,
			text: "We could do that.",
			silenceSinceMs: EOT_COMMIT_SILENCE_MS,
		});

		expect(machine.getState()).toBe("SPEAKING");
		expect(commits).toHaveLength(1);
		expect(commits[0].transcript).toBe("We could do that.");
	});

	it("P<0.4 across two chunks → extension accumulates additively", async () => {
		const midClauseClf: EotClassifier = { score: async () => 0.1 };
		const { machine } = makeMachine(midClauseClf);

		await machine.dispatch({ type: "speech-start", timestampMs: 0 });

		for (let i = 0; i < 2; i++) {
			await machine.dispatch({
				type: "partial-transcript",
				timestampMs: 100 + i * 100,
				text: "I want to go to",
				silenceSinceMs: 5,
			});
		}

		expect(machine.getEotHangoverExtensionMs()).toBe(
			2 * EOT_HANGOVER_EXTENSION_MS,
		);
	});

	it("speech-start resets the hangover extension", async () => {
		const midClauseClf: EotClassifier = { score: async () => 0.1 };
		const { machine } = makeMachine(midClauseClf);

		await machine.dispatch({ type: "speech-start", timestampMs: 0 });
		await machine.dispatch({
			type: "partial-transcript",
			timestampMs: 200,
			text: "going to",
			silenceSinceMs: 5,
		});
		expect(machine.getEotHangoverExtensionMs()).toBe(EOT_HANGOVER_EXTENSION_MS);

		// New turn.
		await machine.dispatch({
			type: "speech-end",
			timestampMs: 900,
			finalTranscript: "going to the store",
		});
		await machine.dispatch({ type: "speech-start", timestampMs: 1000 });
		expect(machine.getEotHangoverExtensionMs()).toBe(0);
	});

	it("partial-transcript is a no-op when eotClassifier is absent", async () => {
		const { machine, commits } = makeMachine(/* no classifier */);

		await machine.dispatch({ type: "speech-start", timestampMs: 0 });
		await machine.dispatch({
			type: "partial-transcript",
			timestampMs: 300,
			text: "Some text.",
			silenceSinceMs: 500,
		});

		// Should stay in LISTENING — no classifier means no early transition.
		expect(machine.getState()).toBe("LISTENING");
		expect(commits).toHaveLength(0);
	});

	it("partial-transcript while in SPEAKING is silently ignored", async () => {
		const highClf: EotClassifier = { score: vi.fn(async () => 0.95) };
		const { machine } = makeMachine(highClf);

		// Manually drive to SPEAKING.
		await machine.dispatch({ type: "speech-start", timestampMs: 0 });
		await machine.dispatch({
			type: "speech-pause",
			timestampMs: 500,
			partialTranscript: "hello",
		});
		await machine.dispatch({
			type: "speech-end",
			timestampMs: 1200,
			finalTranscript: "hello world",
		});
		expect(machine.getState()).toBe("SPEAKING");

		// A partial-transcript while SPEAKING should not re-commit or error.
		await machine.dispatch({
			type: "partial-transcript",
			timestampMs: 1300,
			text: "something else",
			silenceSinceMs: 100,
		});
		expect(machine.getState()).toBe("SPEAKING");
	});

	it("onEotScore event fires with the classifier result", async () => {
		const clf: EotClassifier = { score: async () => 0.42 };
		const { machine, eotScores } = makeMachine(clf);

		await machine.dispatch({ type: "speech-start", timestampMs: 0 });
		await machine.dispatch({
			type: "partial-transcript",
			timestampMs: 200,
			text: "testing one two three",
			silenceSinceMs: 10,
		});

		expect(eotScores).toHaveLength(1);
		expect(eotScores[0].pDone).toBeCloseTo(0.42);
	});
});

describe("RemoteEotClassifier", () => {
	it("throws on network error instead of manufacturing a score", async () => {
		const clf = new RemoteEotClassifier({
			endpoint: "http://127.0.0.1:1/nonexistent",
			timeoutMs: 50,
		});
		await expect(clf.score("will this error?")).rejects.toThrow();
	});
});
