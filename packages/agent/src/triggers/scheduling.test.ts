/** Verifies event-trigger filters are preserved and reject unsafe recursive input. */

import { describe, expect, it } from "vitest";
import { normalizeText, normalizeTriggerDraft } from "./scheduling.ts";

function eventDraft(eventFilter: Record<string, unknown>) {
  return normalizeTriggerDraft({
    input: {
      kind: "workflow",
      workflowId: "target",
      triggerType: "event",
      eventKind: "workflow_run_event",
      eventFilter,
    },
    fallback: {
      displayName: "Step trigger",
      instructions: "Run workflow",
      triggerType: "event",
      wakeMode: "inject_now",
      enabled: true,
      createdBy: "test",
    },
  });
}

describe("event trigger normalization", () => {
  it("preserves a nested Smithers node filter", () => {
    const eventFilter = {
      event: {
        type: "NodeFinished",
        workflowId: "source",
        nodeId: "collect",
      },
    };

    expect(eventDraft(eventFilter).draft?.eventFilter).toEqual(eventFilter);
  });

  it("rejects non-finite and excessively deep filters", () => {
    expect(eventDraft({ count: Number.POSITIVE_INFINITY }).error).toContain(
      "finite JSON",
    );
    let deep: Record<string, unknown> = { value: 1 };
    for (let index = 0; index < 10; index += 1) deep = { nested: deep };
    expect(eventDraft(deep).error).toContain("8 levels");
  });
});

describe("normalizeText", () => {
  it("safely handles non-string or empty inputs without throwing", () => {
    expect(normalizeText(null as unknown as string)).toBe("");
    expect(normalizeText(undefined as unknown as string)).toBe("");
    expect(normalizeText(123 as unknown as string)).toBe("");
    expect(normalizeText("   hello   world   ")).toBe("hello world");
  });
});
