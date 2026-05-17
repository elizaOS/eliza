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
});
