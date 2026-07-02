import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { AGENT_PRICING } from "../constants/agent-pricing";
import { logger } from "../utils/logger";
import { insufficientCredits402, insufficientCreditsBody } from "./agent-billing-gate-402";

describe("insufficientCreditsBody", () => {
  test("builds the canonical 402 wire shape", () => {
    const body = insufficientCreditsBody({
      balance: 0.02,
      error: "Insufficient credits. Please add funds.",
    });

    expect(body).toStrictEqual({
      success: false,
      code: "insufficient_credits",
      error: "Insufficient credits. Please add funds.",
      requiredBalance: AGENT_PRICING.MINIMUM_DEPOSIT,
      currentBalance: 0.02,
    });
  });

  test("falls back to a generic message when the gate result has no error", () => {
    const body = insufficientCreditsBody({ balance: 0 });

    expect(body.error).toBe("Insufficient credits");
    expect(body.success).toBe(false);
    expect(body.code).toBe("insufficient_credits");
  });
});

describe("insufficientCredits402", () => {
  const warnSpy = spyOn(logger, "warn").mockImplementation(() => undefined);

  afterEach(() => {
    warnSpy.mockClear();
  });

  test("warns with the route line and gate numbers", () => {
    const creditCheck = { balance: 0.05, error: "Insufficient credits." };
    const callsBefore = warnSpy.mock.calls.length;

    const body = insufficientCredits402(
      creditCheck,
      "[agent-api] Resume blocked: insufficient credits",
      { agentId: "agent-1", orgId: "org-1" },
    );

    expect(body).toStrictEqual(insufficientCreditsBody(creditCheck));
    expect(warnSpy.mock.calls).toHaveLength(callsBefore + 1);
    expect(warnSpy.mock.calls.at(-1)).toEqual([
      "[agent-api] Resume blocked: insufficient credits",
      {
        agentId: "agent-1",
        orgId: "org-1",
        balance: 0.05,
        required: AGENT_PRICING.MINIMUM_DEPOSIT,
      },
    ]);
  });
});
