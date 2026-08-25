/**
 * Proves the chat boundary preserves complete action-result summaries and
 * rejects cyclic values instead of silently presenting partial content.
 */
import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { summarizeRuntimeActionResults } from "./chat-routes.ts";

describe("chat action-result integrity", () => {
  it("preserves long, deep, wide, and numerous action results", () => {
    const longText = "x".repeat(2_000);
    const wide = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [`field-${index}`, index]),
    );
    const results = Array.from({ length: 12 }, (_, index) => ({
      success: true,
      text: `${index}:${longText}`,
      values: {
        index,
        wide,
        deep: { level1: { level2: { level3: { complete: longText } } } },
        items: Array.from({ length: 25 }, (_unused, itemIndex) => itemIndex),
      },
      data: { actionName: `ACTION_${index}` },
    }));

    const summaries = summarizeRuntimeActionResults(
      {} as AgentRuntime,
      undefined,
      results,
    );

    expect(summaries).toHaveLength(12);
    expect(summaries[0]?.text).toBe(`0:${longText}`);
    expect(summaries[0]?.values).toEqual(results[0]?.values);
    expect(summaries.at(-1)?.actionName).toBe("ACTION_11");
  });

  it("rejects a cyclic result rather than emitting a partial summary", () => {
    const values: Record<string, unknown> = { complete: "before-cycle" };
    values.self = values;

    expect(() =>
      summarizeRuntimeActionResults({} as AgentRuntime, undefined, [
        {
          success: true,
          values,
          data: { actionName: "CYCLIC" },
        },
      ]),
    ).toThrow("circular object");
  });
});
