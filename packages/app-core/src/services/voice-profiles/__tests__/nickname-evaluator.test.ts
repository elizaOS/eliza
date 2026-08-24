/**
 * Unit tests for NAIVE_NICKNAME_EVALUATOR: pattern-based nickname extraction
 * from transcript lines ("call me X", "my name is X", "I go by X"), the
 * no-match and multi-transcript cases, and the capitalization filter that
 * rejects lowercase candidates.
 */
import { describe, expect, it } from "vitest";
import { NAIVE_NICKNAME_EVALUATOR } from "../nickname-evaluator.ts";

describe("NAIVE_NICKNAME_EVALUATOR", () => {
  it("extracts from 'call me X'", async () => {
    const out = await NAIVE_NICKNAME_EVALUATOR.evaluate([
      { id: "t1", text: "Hey, call me Shaw please." },
    ]);
    expect(out.length).toBe(1);
    expect(out[0]?.nickname).toBe("Shaw");
    expect(out[0]?.subject).toBe("owner");
    expect(out[0]?.supportingTranscriptId).toBe("t1");
  });

  it("extracts from 'my name is X'", async () => {
    const out = await NAIVE_NICKNAME_EVALUATOR.evaluate([
      { id: "t2", text: "Hi, my name is Alex." },
    ]);
    expect(out[0]?.nickname).toBe("Alex");
    expect(out[0]?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("extracts from 'I go by X'", async () => {
    const out = await NAIVE_NICKNAME_EVALUATOR.evaluate([
      { id: "t3", text: "Most folks know me but I go by Riley these days." },
    ]);
    expect(out[0]?.nickname).toBe("Riley");
  });

  it("returns empty when no pattern matches", async () => {
    const out = await NAIVE_NICKNAME_EVALUATOR.evaluate([
      { id: "t4", text: "What's the weather like today?" },
    ]);
    expect(out).toEqual([]);
  });

  it("handles multiple transcripts and multiple matches", async () => {
    const out = await NAIVE_NICKNAME_EVALUATOR.evaluate([
      { id: "a", text: "call me Sam" },
      { id: "b", text: "my name is Jordan" },
      { id: "c", text: "ignore me" },
    ]);
    expect(out.map((p) => p.supportingTranscriptId).sort()).toEqual(["a", "b"]);
  });

  it("ignores lowercase candidates that fail the capitalization pattern", async () => {
    const out = await NAIVE_NICKNAME_EVALUATOR.evaluate([
      { id: "t", text: "call me bro" },
    ]);
    expect(out).toEqual([]);
  });

  it("extracts all three patterns from one transcript in fixed pattern order", async () => {
    const out = await NAIVE_NICKNAME_EVALUATOR.evaluate([
      {
        id: "multi",
        text: "Hey, call me Sam. Honestly my name is Jordan, though I go by Riley.",
      },
    ]);
    expect(out.map((p) => p.nickname)).toEqual(["Sam", "Jordan", "Riley"]);
    expect(out.map((p) => p.confidence)).toEqual([0.85, 0.95, 0.8]);
    expect(out.every((p) => p.subject === "owner")).toBe(true);
    expect(out.every((p) => p.supportingTranscriptId === "multi")).toBe(true);
  });

  it("preserves hyphens and apostrophes inside nicknames", async () => {
    const out = await NAIVE_NICKNAME_EVALUATOR.evaluate([
      { id: "h1", text: "call me Jean-Luc today" },
      { id: "h2", text: "my name is O'Brien" },
    ]);
    expect(out.map((p) => p.nickname)).toEqual(["Jean-Luc", "O'Brien"]);
  });

  it("rejects pattern verbs embedded inside larger words", async () => {
    const recall = await NAIVE_NICKNAME_EVALUATOR.evaluate([
      { id: "r1", text: "recall me Sam please" },
    ]);
    expect(recall).toEqual([]);
    const tommy = await NAIVE_NICKNAME_EVALUATOR.evaluate([
      { id: "r2", text: "Tommy name is Bob" },
    ]);
    expect(tommy).toEqual([]);
  });

  it("keeps only the first occurrence when one pattern repeats within a line", async () => {
    const out = await NAIVE_NICKNAME_EVALUATOR.evaluate([
      { id: "dup", text: "call me Sam, call me Alex" },
    ]);
    expect(out.length).toBe(1);
    expect(out[0]?.nickname).toBe("Sam");
    expect(out[0]?.supportingTranscriptId).toBe("dup");
  });

  it("returns empty for an empty transcript queue", async () => {
    const out = await NAIVE_NICKNAME_EVALUATOR.evaluate([]);
    expect(out).toEqual([]);
  });

  it("stops the capture at sentence punctuation following the name", async () => {
    const out = await NAIVE_NICKNAME_EVALUATOR.evaluate([
      { id: "p1", text: "call me Sam!" },
      { id: "p2", text: "my name is Alex?" },
      { id: "p3", text: "I go by Riley." },
    ]);
    expect(out.map((p) => p.nickname)).toEqual(["Sam", "Alex", "Riley"]);
    expect(out.every((p) => p.subject === "owner")).toBe(true);
  });

  it("accepts names up to the 31-character token limit and rejects longer words", async () => {
    const atLimit = `${"A"}${"b".repeat(30)}`;
    const overLimit = `${atLimit}c`;
    const okOut = await NAIVE_NICKNAME_EVALUATOR.evaluate([
      { id: "cap-ok", text: `call me ${atLimit} thanks` },
    ]);
    expect(okOut.map((p) => p.nickname)).toEqual([atLimit]);
    const overOut = await NAIVE_NICKNAME_EVALUATOR.evaluate([
      { id: "cap-over", text: `call me ${overLimit} thanks` },
    ]);
    expect(overOut).toEqual([]);
  });
});
