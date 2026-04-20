import type { Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import { extractGmailPlanWithLlm } from "../src/actions/gmail.js";

function message(text: string): Memory {
  return {
    id: "m1",
    roomId: "r1",
    entityId: "u1",
    content: { text, source: "test" },
  } as Memory;
}

/**
 * These tests verify the parse/normalize path downstream of a mocked model
 * response — NOT the LLM's judgement. `useModel` is stubbed, so anything the
 * extractor merely passes through from the stubbed JSON is tautological and
 * not worth asserting here.
 *
 * Only tests that exercise real branching or field-forcing logic in
 * `extractGmailPlanWithLlm` (skipping the payload pass, forcing defaults,
 * etc.) belong in this file. Tests that asserted equality with the mock's
 * own output have been removed.
 */
describe("extractGmailPlanWithLlm — downstream normalization (LLM mocked)", () => {
  it("skips the payload-extraction pass for triage subactions", async () => {
    // Real logic under test: `shouldExtractGmailPayload(subaction)` must return
    // false for "triage", so the extractor returns after a single LLM call
    // instead of running the second payload-extraction pass. The mock is
    // configured to throw on any call after the first; if the branch ever
    // regresses the second call will blow up.
    const useModel = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          subaction: "triage",
          shouldAct: true,
          response: null,
        }),
      )
      .mockRejectedValue(
        new Error(
          "payload-extraction pass should not run for triage subaction",
        ),
      );

    const plan = await extractGmailPlanWithLlm(
      {
        useModel,
        logger: { warn: vi.fn() },
        getMemories: vi.fn().mockResolvedValue([]),
      } as never,
      message("check my inbox"),
      undefined,
      "check my inbox",
    );

    expect(useModel).toHaveBeenCalledTimes(1);
    // Payload-pass-only fields must be absent/empty because that pass was
    // skipped — the only interesting assertion here.
    expect(plan.queries).toEqual([]);
    expect(plan.replyNeededOnly).toBeUndefined();
    expect(plan.subaction).toBe("triage");
    expect(plan.shouldAct).toBe(true);
  });

  it("forces replyNeededOnly=true for needs_response even when the payload pass omits it", async () => {
    // Real logic under test: lines ~1099-1101 in gmail.ts — after the payload
    // pass returns, if subaction is "needs_response" and the LLM did NOT
    // include replyNeededOnly, the extractor must force it to true. The
    // payload-pass mock below deliberately omits replyNeededOnly; if this
    // defaulting logic regresses, `plan.replyNeededOnly` will be undefined.
    const useModel = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          subaction: "needs_response",
          shouldAct: true,
          response: null,
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          queries: ["venue"],
          // replyNeededOnly intentionally omitted
        }),
      );

    const plan = await extractGmailPlanWithLlm(
      {
        useModel,
        logger: { warn: vi.fn() },
        getMemories: vi.fn().mockResolvedValue([]),
      } as never,
      message("which emails need a reply about venue"),
      undefined,
      "which emails need a reply about venue",
    );

    expect(useModel).toHaveBeenCalledTimes(2);
    expect(plan.subaction).toBe("needs_response");
    // The LLM omitted replyNeededOnly; the extractor must default it to true.
    expect(plan.replyNeededOnly).toBe(true);
  });
});
