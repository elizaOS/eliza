/**
 * A daily limit of $0 is a cap. `dailyLimit ? dailyLimit - spent` treated 0
 * as "no daily limit", so the agent was told it could still afford a chat.
 */

import { beforeAll, describe, expect, mock, test } from "bun:test";

const getBudget = mock(async (): Promise<Record<string, unknown> | null> => null);

mock.module("../services/agent-budgets", () => ({
  agentBudgetService: { getBudget },
}));
mock.module("../services/organizations", () => ({
  organizationsService: { getById: async () => null },
}));
mock.module("../utils/logger", () => ({
  logger: { debug() {}, warn() {}, info() {}, error() {} },
}));

type Credits = {
  dailyLimit: number | null;
  dailyRemaining: number | null;
  canAffordChat: boolean;
  statusText: string;
};

let getCredits: (runtime: unknown, message: unknown) => Promise<{ data?: unknown }>;

beforeAll(async () => {
  const loaded = await import("./plugin-cloud-billing");
  getCredits = loaded.agentCreditsProvider.get.bind(loaded.agentCreditsProvider);
});

async function creditsFor(dailyLimit: string | null): Promise<Credits> {
  getBudget.mockResolvedValue({
    allocated_budget: "10.0000",
    spent_budget: "0.0000",
    daily_limit: dailyLimit,
    daily_spent: "0.0000",
    is_paused: false,
    pause_reason: null,
  });
  const result = await getCredits({ agentId: "agent-1", character: { settings: {} } }, undefined);
  const data = result.data as { credits: Credits };
  return data.credits;
}

describe("agent credits daily limit of 0", () => {
  test("a stored $0 daily limit blocks a chat", async () => {
    const credits = await creditsFor("0.0000");
    expect(credits.dailyLimit).toBe(0);
    expect(credits.dailyRemaining).toBe(0);
    expect(credits.canAffordChat).toBe(false);
    expect(credits.statusText).not.toContain("no daily limit");
  });

  test("a missing daily limit is still unlimited", async () => {
    const credits = await creditsFor(null);
    expect(credits.dailyLimit).toBeNull();
    expect(credits.dailyRemaining).toBeNull();
    expect(credits.canAffordChat).toBe(true);
    expect(credits.statusText).toContain("no daily limit");
  });
});
