/**
 * The renderer validates output shape, not semantic truth by English words.
 * Receipt-grounded Calendar claims are evaluated by the existing planner
 * evaluator; its handoff is covered by calendar.evaluator-handoff.test.ts.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { renderGroundedActionReply } from "./grounded-action-reply.ts";

async function render(modelText: string) {
  const reportError = vi.fn();
  const runtime = {
    getMemories: vi.fn(async () => []),
    reportError,
    logger: { warn: vi.fn() },
    character: { name: "TestAgent" },
    useModel: vi.fn(async () => modelText),
  } as unknown as IAgentRuntime;
  const outcome = await renderGroundedActionReply({
    runtime,
    message: { content: { text: "yes, delete it" } } as Memory,
    state: undefined,
    intent: "delete the gym session",
    domain: "calendar",
    scenario: "delete_event_not_found",
    fallback: "I couldn't find the requested event.",
  });
  return { outcome, reportError };
}

describe("grounded reply shape validation is language independent", () => {
  it.each([
    "The event is absent from the search results; deletion remains unperformed.",
    "Die Suche blieb ergebnislos; der Löschvorgang wurde ausgelassen.",
    "El evento está ausente; la eliminación quedó sin realizar.",
  ])(
    "preserves plain model text without requiring English negation: %s",
    async (modelText) => {
      const { outcome, reportError } = await render(modelText);
      expect(outcome).toEqual({ kind: "model", text: modelText });
      expect(reportError).not.toHaveBeenCalled();
    },
  );

  it.each([
    "The gym session is gone.",
    "No problem, I deleted it.",
    "No hay problema, ya eliminé el evento.",
  ])(
    "does not mistake lexical shape validation for semantic verification: %s",
    async (modelText) => {
      const { outcome } = await render(modelText);
      expect(outcome).toEqual({ kind: "model", text: modelText });
    },
  );

  it("still rejects a protocol object instead of reply text", async () => {
    const { outcome, reportError } = await render('{"decision":"FINISH"}');
    expect(outcome).toMatchObject({
      kind: "unavailable",
      failure: { code: "GROUNDED_REPLY_OUTPUT_INVALID" },
    });
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
