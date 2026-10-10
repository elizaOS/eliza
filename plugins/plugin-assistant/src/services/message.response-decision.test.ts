/**
 * The host respond-decision signal on the real message pipeline (AgentRuntime +
 * SQLite; only the model surface is a deterministic registered handler). It
 * fires once when Stage 1 commits to a response, before delivery, and never
 * for an ignored turn.
 */

import { describe, expect, it, vi } from "vitest";
import { stage1Response } from "../__tests__/stage1/fixtures.js";
import { createRealRuntimeHarness } from "./__tests__/real-runtime-harness.ts";

const QUESTION = "where is the picnic now?";
const decision =
  (shouldRespond: "RESPOND" | "IGNORE", replyText: string) => () =>
    stage1Response({
      shouldRespond,
      replyText,
      thought: "Decide.",
      contexts: ["simple"],
    });

describe("message respond-decision signal", () => {
  it("fires once when Stage 1 commits to a response, before the reply is delivered", async () => {
    const h = await createRealRuntimeHarness(
      decision("RESPOND", "on the north lawn."),
    );
    const order: string[] = [];
    const result = await h.service.handleMessage(
      h.runtime,
      h.makeMessage(QUESTION),
      async (content) => {
        if (content.text) order.push(`deliver:${content.text}`);
        return [];
      },
      { onResponseDecision: () => order.push("decision") },
    );
    expect(result.didRespond).toBe(true);
    expect(order).toEqual(["decision", "deliver:on the north lawn."]);
  });

  it("never fires for a turn Stage 1 ignores", async () => {
    const stage1 = vi.fn(decision("IGNORE", ""));
    const h = await createRealRuntimeHarness(stage1);
    const onResponseDecision = vi.fn();
    const delivered: string[] = [];
    const result = await h.service.handleMessage(
      h.runtime,
      h.makeMessage(QUESTION),
      async (content) => {
        if (content.text) delivered.push(content.text);
        return [];
      },
      { onResponseDecision },
    );
    expect(stage1).toHaveBeenCalled();
    expect(result.didRespond).toBe(false);
    expect(delivered).toEqual([]);
    expect(onResponseDecision).not.toHaveBeenCalled();
  });
});
