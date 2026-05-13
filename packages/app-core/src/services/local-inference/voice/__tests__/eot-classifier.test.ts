/**
 * Tests for the Tier-3 semantic EOT classifier:
 *
 *   1. HeuristicEotClassifier — punctuation, conjunctions, short utterances, etc.
 *   2. State machine integration — P≥0.9 commits early, P<0.4 extends hangover.
 *   3. Interface contract — both HeuristicEotClassifier and a mock RemoteEotClassifier
 *      satisfy EotClassifier.
 */

import { describe, expect, it, vi } from "vitest";
import { MockCheckpointManager } from "../checkpoint-manager";
import {
  EOT_COMMIT_SILENCE_MS,
  EOT_COMMIT_THRESHOLD,
  EOT_HANGOVER_EXTENSION_MS,
  EOT_MID_CLAUSE_THRESHOLD,
  EOT_TENTATIVE_SILENCE_MS,
  EOT_TENTATIVE_THRESHOLD,
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 1. HeuristicEotClassifier
// ---------------------------------------------------------------------------

describe("HeuristicEotClassifier — rule coverage", () => {
  const clf = new HeuristicEotClassifier();

  it("sentence-final period → P=0.95", async () => {
    expect(await clf.score("I'd like some bread.")).toBe(0.95);
  });

  it("sentence-final exclamation → P=0.95", async () => {
    expect(await clf.score("That's amazing!")).toBe(0.95);
  });

  it("sentence-final question mark → P=0.95", async () => {
    expect(await clf.score("Can you help me?")).toBe(0.95);
  });

  // Question-tag words that include a trailing "?" are also caught by rule 1
  // (sentence-final punctuation → 0.95). To exercise rule 2 in isolation, use
  // the without-punctuation forms ("right", "yeah", "correct").
  it("question tag 'right' suffix (no trailing ?) → P=0.85", async () => {
    expect(await clf.score("That's correct right")).toBe(0.85);
  });

  it("question tag 'yeah' suffix (no trailing ?) → P=0.85", async () => {
    expect(await clf.score("It is ready yeah")).toBe(0.85);
  });

  it("question tag 'correct' suffix (no trailing ?) → P=0.85", async () => {
    expect(await clf.score("That makes sense correct")).toBe(0.85);
  });

  it("question tag 'right?' with trailing ? is caught by rule 1 → P=0.95", async () => {
    // Sentence-final punctuation fires before the tag check.
    expect(await clf.score("That's correct, right?")).toBe(0.95);
  });

  it("short utterance (1 word) → P=0.70", async () => {
    expect(await clf.score("Yes")).toBe(0.7);
  });

  it("short utterance (2 words) → P=0.70", async () => {
    expect(await clf.score("No thanks")).toBe(0.7);
  });

  it("trailing conjunction 'and' → P=0.15", async () => {
    expect(await clf.score("I want to go to the store and")).toBe(0.15);
  });

  it("trailing conjunction 'but' → P=0.15", async () => {
    expect(await clf.score("I was going to say something but")).toBe(0.15);
  });

  it("trailing conjunction 'because' → P=0.15", async () => {
    expect(await clf.score("I can't do that because")).toBe(0.15);
  });

  it("trailing preposition 'to' → P=0.20", async () => {
    expect(await clf.score("I want to go to")).toBe(0.2);
  });

  it("trailing article 'the' → P=0.20", async () => {
    expect(await clf.score("Can you bring me the")).toBe(0.2);
  });

  it("trailing article 'a' → P=0.20", async () => {
    expect(await clf.score("I need a")).toBe(0.2);
  });

  it("no signal (neutral content) → P=0.50", async () => {
    expect(await clf.score("Tell me about the weather in London")).toBe(0.5);
  });

  it("empty string → P=0.50", async () => {
    expect(await clf.score("")).toBe(0.5);
  });

  it("whitespace only → P=0.50", async () => {
    expect(await clf.score("   ")).toBe(0.5);
  });

  it("P ≥ EOT_COMMIT_THRESHOLD for sentence-final punct", async () => {
    const p = await clf.score("Done.");
    expect(p).toBeGreaterThanOrEqual(EOT_COMMIT_THRESHOLD);
  });

  it("P < EOT_MID_CLAUSE_THRESHOLD for trailing conjunction", async () => {
    const p = await clf.score("We should probably and");
    expect(p).toBeLessThan(EOT_MID_CLAUSE_THRESHOLD);
  });

  it("P ≥ EOT_TENTATIVE_THRESHOLD for question tag", async () => {
    const p = await clf.score("That works right?");
    expect(p).toBeGreaterThanOrEqual(EOT_TENTATIVE_THRESHOLD);
  });
});

// ---------------------------------------------------------------------------
// 2. State machine integration
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 3. Interface contract
// ---------------------------------------------------------------------------

describe("EotClassifier interface contract", () => {
  it("HeuristicEotClassifier satisfies EotClassifier", () => {
    const clf: EotClassifier = new HeuristicEotClassifier();
    expect(typeof clf.score).toBe("function");
  });

  it("RemoteEotClassifier satisfies EotClassifier (stub; no real network call in unit tests)", () => {
    const clf: EotClassifier = new RemoteEotClassifier({
      endpoint: "http://localhost:9999/eot",
    });
    expect(typeof clf.score).toBe("function");
  });

  it("mock RemoteEotClassifier satisfies EotClassifier", () => {
    const mockClf: EotClassifier = {
      score: async (_text: string) => 0.5,
    };
    expect(typeof mockClf.score).toBe("function");
  });

  it("RemoteEotClassifier returns fallbackScore on network error", async () => {
    // The endpoint doesn't exist; fetch will throw. We expect the fallback.
    const clf = new RemoteEotClassifier({
      endpoint: "http://127.0.0.1:1/nonexistent",
      timeoutMs: 50,
      fallbackScore: 0.42,
    });
    const result = await clf.score("will this error?");
    expect(result).toBe(0.42);
  });

  it("score() always returns a value in [0, 1] for heuristic classifier", async () => {
    const clf = new HeuristicEotClassifier();
    const inputs = [
      "",
      "hello",
      "I want to",
      "Done!",
      "We should go and",
      "Tell me about the history of AI in the modern era",
    ];
    for (const input of inputs) {
      const p = await clf.score(input);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it("EOT_COMMIT_THRESHOLD > EOT_TENTATIVE_THRESHOLD > EOT_MID_CLAUSE_THRESHOLD", () => {
    expect(EOT_COMMIT_THRESHOLD).toBeGreaterThan(EOT_TENTATIVE_THRESHOLD);
    expect(EOT_TENTATIVE_THRESHOLD).toBeGreaterThan(EOT_MID_CLAUSE_THRESHOLD);
  });

  it("EOT_COMMIT_SILENCE_MS > EOT_TENTATIVE_SILENCE_MS", () => {
    expect(EOT_COMMIT_SILENCE_MS).toBeGreaterThan(EOT_TENTATIVE_SILENCE_MS);
  });
});
