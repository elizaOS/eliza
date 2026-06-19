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
