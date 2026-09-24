/**
 * Proves the chat boundary preserves complete action-result summaries and
 * rejects cyclic values instead of silently presenting partial content.
 */
import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { summarizeRuntimeActionResults } from "./chat-routes.ts";

describe("chat action-result integrity", () => {
  it("preserves committed effects when a later operation fails", () => {
    const receipt = {
      receiptId: "delete-receipt",
      operation: "notes.note.delete",
      resource: { kind: "notes.note", id: "deleted-note" },
      artifacts: [],
      idempotency: { key: "delete-key", replayed: false },
      observedAt: "2026-09-24T03:03:21.000Z",
      outcome: "applied" as const,
      commit: {
        kind: "durable" as const,
        id: "deleted-note",
        committedAt: "2026-09-24T03:03:21.000Z",
      },
    };
    const results = summarizeRuntimeActionResults(
      {} as AgentRuntime,
      undefined,
      [
        {
          success: true,
          data: { actionName: "NOTES_DELETE" },
          effectReceipts: [receipt],
        },
        {
          success: false,
          data: { actionName: "NOTES_PATCH" },
          error: "NOTES_EDIT_REVISION_REQUIRED",
        },
      ],
    );
    expect(results[0]?.effectReceipts).toEqual([receipt]);
    expect(results[1]).toMatchObject({
      success: false,
      error: "NOTES_EDIT_REVISION_REQUIRED",
    });
  });
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
