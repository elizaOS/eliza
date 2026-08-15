/**
 * Exercises strict serialization and parsing at the onboarding Durable Object
 * boundary with real Response bodies and adversarial payload shapes.
 */

import { describe, expect, test } from "bun:test";
import { ElizaError, isElizaError } from "@elizaos/core";
import {
  onboardingCoordinatorErrorResponse,
  readOnboardingCoordinatorResult,
} from "@/lib/services/eliza-app/onboarding-coordinator-transport";

describe("onboarding coordinator transport", () => {
  test("preserves an ElizaError code and context at HTTP 500", async () => {
    const response = onboardingCoordinatorErrorResponse(
      new ElizaError("Continuation rejected", {
        code: "ONBOARDING_TRUSTED_CONTINUATION_INVALID",
        context: { platform: "telegram", sessionFound: false },
      }),
    );

    expect(response.status).toBe(500);
    expect((await response.json()) as unknown).toEqual({
      error: "Continuation rejected",
      code: "ONBOARDING_TRUSTED_CONTINUATION_INVALID",
      context: { platform: "telegram", sessionFound: false },
    });
  });

  test("reconstructs a typed error only from message plus non-empty code", async () => {
    const response = Response.json(
      {
        error: "Continuation rejected",
        code: "ONBOARDING_TRUSTED_CONTINUATION_INVALID",
        context: { sessionFound: false },
      },
      { status: 500 },
    );

    try {
      await readOnboardingCoordinatorResult(response);
      throw new Error("expected coordinator failure");
    } catch (error) {
      expect(isElizaError(error)).toBe(true);
      if (!isElizaError(error)) throw error;
      expect(error.code).toBe("ONBOARDING_TRUSTED_CONTINUATION_INVALID");
      expect(error.context).toEqual({ sessionFound: false });
    }
  });

  for (const [name, body] of [
    ["null", "null"],
    ["array", "[]"],
    ["missing error", JSON.stringify({ code: "AUTH" })],
    ["non-string error", JSON.stringify({ error: 42, code: "AUTH" })],
    ["missing code", JSON.stringify({ error: "no code" })],
    ["non-string code", JSON.stringify({ error: "bad code", code: 42 })],
    ["empty code", JSON.stringify({ error: "empty code", code: "  " })],
  ] as const) {
    test(`keeps ${name} payload generic`, async () => {
      const error = await readOnboardingCoordinatorResult(
        new Response(body, { status: 500 }),
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(isElizaError(error)).toBe(false);
      expect((error as Error).message).toBe(
        "onboarding session coordinator failed (500)",
      );
    });
  }

  test("keeps unreadable JSON generic", async () => {
    const error = await readOnboardingCoordinatorResult(
      new Response("not-json", { status: 500 }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(isElizaError(error)).toBe(false);
  });
});
