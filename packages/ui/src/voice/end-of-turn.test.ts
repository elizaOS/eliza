/**
 * Unit coverage for end-of-turn scoring and the turn aggregator (when the user
 * has finished speaking). Pure functions, no live ASR.
 */
import { describe, expect, it, vi } from "vitest";

import { scoreEndOfTurn, TurnAggregator } from "./end-of-turn";

describe("scoreEndOfTurn", () => {
  it("treats sentence-final punctuation as complete", () => {
    expect(scoreEndOfTurn("what time is it?")).toBeGreaterThanOrEqual(0.9);
    expect(scoreEndOfTurn("set a reminder.")).toBeGreaterThanOrEqual(0.9);
    expect(scoreEndOfTurn("stop!")).toBeGreaterThanOrEqual(0.9);
  });

  it("treats short commands/acknowledgements as complete", () => {
    expect(scoreEndOfTurn("go home")).toBeGreaterThanOrEqual(0.5);
    expect(scoreEndOfTurn("yes")).toBeGreaterThanOrEqual(0.5);
    expect(scoreEndOfTurn("open settings")).toBeGreaterThanOrEqual(0.5);
  });

  it("treats a trailing conjunction as UNFINISHED (slow speaker mid-clause)", () => {
    expect(scoreEndOfTurn("buy milk and")).toBeLessThan(0.5);
    expect(scoreEndOfTurn("remind me to call her because")).toBeLessThan(0.5);
    expect(scoreEndOfTurn("i went to the store but")).toBeLessThan(0.5);
  });

  it("treats a trailing preposition/article as UNFINISHED (incomplete NP)", () => {
    expect(scoreEndOfTurn("schedule a meeting with")).toBeLessThan(0.5);
    expect(scoreEndOfTurn("set a reminder for")).toBeLessThan(0.5);
    expect(scoreEndOfTurn("put it on the")).toBeLessThan(0.5);
  });

  it("commits a complete clause that doesn't trail off", () => {
    expect(
      scoreEndOfTurn("schedule a meeting with bob"),
    ).toBeGreaterThanOrEqual(0.5);
    expect(scoreEndOfTurn("buy milk and eggs")).toBeGreaterThanOrEqual(0.5);
  });

  it("treats a 2-word trailing function-word as UNFINISHED (rule-ordering fix)", () => {
    // These must NOT be misread as complete 2-word commands.
    expect(scoreEndOfTurn("going to")).toBeLessThan(0.5); // trailing preposition
    expect(scoreEndOfTurn("and so")).toBeLessThan(0.5); // trailing conjunction
    expect(scoreEndOfTurn("set the")).toBeLessThan(0.5); // trailing article
  });

  it("treats a trailing ellipsis as UNFINISHED", () => {
    expect(scoreEndOfTurn("so i was thinking...")).toBeLessThan(0.5);
    expect(scoreEndOfTurn("hmm…")).toBeLessThan(0.5);
    expect(scoreEndOfTurn("wait..")).toBeLessThan(0.5);
  });

  it("does not misfire on punctuation/whitespace/garbage (fuzz)", () => {
    for (const junk of ["", "   ", "...", "?!", "\n\t", "—", "123 456"]) {
      const s = scoreEndOfTurn(junk);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});

describe("TurnAggregator", () => {
  // Deterministic injectable timer.
  function makeAgg() {
    let pendingCb: (() => void) | null = null;
    const onCommit = vi.fn();
    const agg = new TurnAggregator({
      onCommit,
      maxHoldMs: 3500,
      setTimer: (cb) => {
        pendingCb = cb;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {
        pendingCb = null;
      },
    });
    return { agg, onCommit, fireTimer: () => pendingCb?.() };
  }

  it("commits a complete utterance immediately", () => {
    const { agg, onCommit } = makeAgg();
    expect(agg.addFinal("what time is it?")).toBe(true);
    expect(onCommit).toHaveBeenCalledWith("what time is it?");
  });

  it("holds an unfinished utterance and appends the continuation (slow speaker)", () => {
    const { agg, onCommit } = makeAgg();
    // "schedule a meeting with" → trailing preposition → HOLD, do not send.
    expect(agg.addFinal("schedule a meeting with")).toBe(false);
    expect(onCommit).not.toHaveBeenCalled();
    expect(agg.pending).toBe("schedule a meeting with");

    // The speaker resumes after the pause → append → now complete → commit.
    expect(agg.addFinal("bob tomorrow")).toBe(true);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(
      "schedule a meeting with bob tomorrow",
    );
  });

  it("chains multiple mid-clause pauses before committing", () => {
    const { agg, onCommit } = makeAgg();
    expect(agg.addFinal("remind me to")).toBe(false); // trailing "to"
    expect(agg.addFinal("call my mom and")).toBe(false); // trailing "and"
    expect(agg.addFinal("my dad")).toBe(true);
    expect(onCommit).toHaveBeenCalledWith(
      "remind me to call my mom and my dad",
    );
  });

  it("commits a trailed-off utterance when the max-hold timer fires", () => {
    const { agg, onCommit, fireTimer } = makeAgg();
    expect(agg.addFinal("i was thinking and")).toBe(false);
    expect(onCommit).not.toHaveBeenCalled();
    fireTimer(); // the speaker genuinely stopped after "and"
    expect(onCommit).toHaveBeenCalledWith("i was thinking and");
  });

  it("reset() discards a held turn without committing (toggle-off / barge-in)", () => {
    const { agg, onCommit } = makeAgg();
    agg.addFinal("schedule a meeting with");
    agg.reset();
    expect(agg.pending).toBe("");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("seed() carries a held turn into a fresh aggregator and appends the continuation", () => {
    const { agg, onCommit } = makeAgg();
    agg.seed("schedule a meeting with"); // carried from a prior one-shot capture
    expect(agg.pending).toBe("schedule a meeting with");
    expect(onCommit).not.toHaveBeenCalled();
    expect(agg.addFinal("bob")).toBe(true);
    expect(onCommit).toHaveBeenCalledWith("schedule a meeting with bob");
  });

  it("seed() arms the max-hold timer so a carried-but-abandoned turn still commits", () => {
    const { agg, onCommit, fireTimer } = makeAgg();
    agg.seed("i was going to");
    expect(onCommit).not.toHaveBeenCalled();
    fireTimer();
    expect(onCommit).toHaveBeenCalledWith("i was going to");
  });

  it("flush() commits a held partial (e.g. push-to-talk release)", () => {
    const { agg, onCommit } = makeAgg();
    agg.addFinal("remind me to");
    agg.flush();
    expect(onCommit).toHaveBeenCalledWith("remind me to");
  });

  it("ignores empty/whitespace finals", () => {
    const { agg, onCommit } = makeAgg();
    expect(agg.addFinal("   ")).toBe(false);
    expect(agg.addFinal("")).toBe(false);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits each complete turn independently across a conversation", () => {
    const { agg, onCommit } = makeAgg();
    agg.addFinal("what's the weather?");
    agg.addFinal("thanks");
    expect(onCommit).toHaveBeenNthCalledWith(1, "what's the weather?");
    expect(onCommit).toHaveBeenNthCalledWith(2, "thanks");
  });
});

// ── Adversarial / fuzz ───────────────────────────────────────────────────────
// The end-of-turn layer sits on the raw STT output, which is noisy, partial, and
// occasionally garbage. None of it may throw, hang, or commit a malformed turn.
describe("end-of-turn — adversarial / fuzz", () => {
  // Deterministic LCG so the fuzz corpus is reproducible (no Math.random).
  function makeRng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (1103515245 * s + 12345) >>> 0;
      return s;
    };
  }

  it("scoreEndOfTurn never throws and stays in [0,1] for random byte soup", () => {
    const rng = makeRng(0xc0ffee);
    const alphabet = "abcdefghijklmnopqrstuvwxyz ?!.,'-0123456789\n\téç你好🙂—";
    for (let i = 0; i < 2000; i += 1) {
      const len = rng() % 80;
      let s = "";
      for (let j = 0; j < len; j += 1) {
        s += alphabet[rng() % alphabet.length];
      }
      const score = scoreEndOfTurn(s);
      expect(Number.isFinite(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it("handles unicode / emoji / CJK / numerals without misfiring", () => {
    for (const s of [
      "你好吗",
      "😀😀😀",
      "1 2 3 4 5",
      "café crème brûlée",
      "—",
    ]) {
      expect(() => scoreEndOfTurn(s)).not.toThrow();
    }
  });

  it("handles a very long utterance", () => {
    const long = `${"word ".repeat(4000)}done.`;
    expect(scoreEndOfTurn(long)).toBeGreaterThanOrEqual(0.9);
  });

  it("a slow speaker emitting many trailing-conjunction fragments still forms one turn", () => {
    let committed: string | null = null;
    let pendingCb: (() => void) | null = null;
    const agg = new TurnAggregator({
      onCommit: (t) => {
        committed = t;
      },
      setTimer: (cb) => {
        pendingCb = cb;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {
        pendingCb = null;
      },
    });
    // Every fragment trails off → none should commit until a complete one.
    for (const frag of ["i need to", "go to the store and", "also call the"]) {
      expect(agg.addFinal(frag)).toBe(false);
    }
    expect(committed).toBeNull();
    expect(agg.addFinal("dentist tomorrow")).toBe(true);
    expect(committed).toBe(
      "i need to go to the store and also call the dentist tomorrow",
    );
    expect(pendingCb).toBeNull(); // timer cleared on commit
  });

  it("a turn that NEVER completes is committed by the safety timer, not dropped", () => {
    const state: { committed: string | null; cb: (() => void) | null } = {
      committed: null,
      cb: null,
    };
    const agg = new TurnAggregator({
      onCommit: (t) => {
        state.committed = t;
      },
      setTimer: (cb) => {
        state.cb = cb;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {},
    });
    agg.addFinal("um so basically i was like and then and");
    expect(state.committed).toBeNull();
    state.cb?.(); // max-hold elapses
    expect(state.committed).toBe("um so basically i was like and then and");
  });

  it("interleaved finals (two speakers heard by one recognizer) still segment coherently", () => {
    const commits: string[] = [];
    const agg = new TurnAggregator({
      onCommit: (t) => commits.push(t),
    });
    // Speaker A asks a complete question, speaker B a complete one — each is a
    // self-contained turn (no diarization here, but neither is dropped/merged
    // wrongly because both read as complete).
    agg.addFinal("what time is it?");
    agg.addFinal("turn on the lights.");
    expect(commits).toEqual(["what time is it?", "turn on the lights."]);
  });

  it("garbage/empty finals never commit a turn", () => {
    const commits: string[] = [];
    const agg = new TurnAggregator({ onCommit: (t) => commits.push(t) });
    for (const junk of ["", "   ", "\n", "\t  \t"]) {
      expect(agg.addFinal(junk)).toBe(false);
    }
    expect(commits).toHaveLength(0);
  });
});
