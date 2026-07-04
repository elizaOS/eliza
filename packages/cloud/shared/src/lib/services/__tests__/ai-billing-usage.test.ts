// Exercises ai billing usage behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import { normalizeUsage } from "../ai-billing";

const u = (o: Record<string, unknown>) => o as Parameters<typeof normalizeUsage>[0];

// Usage feeds the charge; it must normalize across AI-SDK versions/providers
// (v4 inputTokens, previous promptTokens, and two cache-token namings) consistently.
describe("normalizeUsage", () => {
  test("returns all-zeros for null/undefined", () => {
    for (const v of [null, undefined]) {
      expect(normalizeUsage(v)).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
      });
    }
  });

  test("maps AI SDK v4 field names", () => {
    expect(normalizeUsage(u({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }))).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });

  test("maps legacy promptTokens/completionTokens + derives total", () => {
    const r = normalizeUsage(u({ promptTokens: 8, completionTokens: 2 }));
    expect(r.inputTokens).toBe(8);
    expect(r.outputTokens).toBe(2);
    expect(r.totalTokens).toBe(10);
  });

  test("new field names win over legacy when both are present", () => {
    const r = normalizeUsage(
      u({
        inputTokens: 1,
        promptTokens: 99,
        outputTokens: 2,
        completionTokens: 99,
      }),
    );
    expect(r.inputTokens).toBe(1);
    expect(r.outputTokens).toBe(2);
  });

  test("normalizes both cache-token naming variants", () => {
    expect(normalizeUsage(u({ cacheReadInputTokens: 3, cacheWriteInputTokens: 4 }))).toMatchObject({
      cacheReadInputTokens: 3,
      cacheWriteInputTokens: 4,
    });
    expect(normalizeUsage(u({ cachedInputTokens: 7, cacheCreationInputTokens: 9 }))).toMatchObject({
      cacheReadInputTokens: 7,
      cacheWriteInputTokens: 9,
    });
  });
});
