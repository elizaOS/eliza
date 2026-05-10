import { describe, expect, mock, test } from "bun:test";

let mockedBalance: number | null = null;

mock.module("@/db/repositories", () => ({
  organizationsRepository: {
    findById: async () =>
      mockedBalance === null
        ? null
        : { id: "org-1", credit_balance: String(mockedBalance) },
  },
}));

mock.module("@/lib/constants/agent-pricing", () => ({
  AGENT_PRICING: { MINIMUM_DEPOSIT: 0.1 },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
  },
}));

const { checkAgentCreditGate } = await import(
  "@/lib/services/agent-billing-gate"
);

async function runGateScenario(balance: number | null) {
  mockedBalance = balance;
  return checkAgentCreditGate("org-1");
}

describe("Agent billing gate", () => {
  test("blocks balances at or below ten cents", async () => {
    await expect(runGateScenario(0.1)).resolves.toMatchObject({
      allowed: false,
      balance: 0.1,
    });
  });

  test("allows balances greater than ten cents", async () => {
    await expect(runGateScenario(0.11)).resolves.toEqual({
      allowed: true,
      balance: 0.11,
    });
  });
});
