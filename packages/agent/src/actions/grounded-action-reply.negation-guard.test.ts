/**
 * Grounded reply rendering for failure scenarios: a model rewrite that drops
 * the canonical fallback's negation is rejected as invalid output and surfaces
 * as an unavailable reply, while negation-preserving rewrites and positive
 * scenarios pass. Runtime doubles stand in for IAgentRuntime; the renderer is
 * not mocked.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { renderGroundedActionReply } from "./grounded-action-reply.ts";

async function render(args: {
  modelText: string;
  scenario: string;
  fallback: string;
}) {
  const reportError = vi.fn();
  const runtime = {
    getMemories: vi.fn(async () => []),
    reportError,
    logger: { warn: vi.fn() },
    character: { name: "TestAgent" },
    useModel: vi.fn(async () => args.modelText),
  } as unknown as IAgentRuntime;
  const outcome = await renderGroundedActionReply({
    runtime,
    message: { content: { text: "yes, delete it" } } as Memory,
    state: undefined,
    intent: "delete the gym session",
    domain: "calendar",
    scenario: args.scenario,
    fallback: args.fallback,
  });
  return { outcome, reportError };
}

const NOT_FOUND_FALLBACK =
  "i couldn't find an event matching 'Gym session September 8 2026 7:00' in that window.";

describe("renderGroundedActionReply negation guard", () => {
  it("rejects a failure-scenario rewrite that claims the mutation happened", async () => {
    // Live 2026-09-05: delete_event_not_found with a noop receipt was
    // delivered as "The Gym session Tuesday at 7 AM (Sep 8) is gone."
    const { outcome, reportError } = await render({
      modelText: "The Gym session Tuesday at 7 AM (Sep 8) is gone.",
      scenario: "delete_event_not_found",
      fallback: NOT_FOUND_FALLBACK,
    });
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind === "unavailable") {
      expect(outcome.failure.code).toBe("GROUNDED_REPLY_OUTPUT_INVALID");
    }
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("accepts a failure-scenario rewrite that keeps the negation", async () => {
    const { outcome } = await render({
      modelText: "I couldn't find a gym session on Tuesday to delete.",
      scenario: "delete_event_not_found",
      fallback: NOT_FOUND_FALLBACK,
    });
    expect(outcome).toEqual({
      kind: "model",
      text: "I couldn't find a gym session on Tuesday to delete.",
    });
  });

  it("does not screen positive scenarios whose fallback merely contains a negation", async () => {
    const { outcome } = await render({
      modelText: "Tuesday's clear.",
      scenario: "search_results",
      fallback: "nothing on your calendar for tuesday.",
    });
    expect(outcome).toEqual({ kind: "model", text: "Tuesday's clear." });
  });
});
