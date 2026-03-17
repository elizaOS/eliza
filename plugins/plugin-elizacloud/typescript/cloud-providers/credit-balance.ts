/**
 * creditBalanceProvider — Credit balance in agent state (60s cache).
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { CloudAuthService } from "../services/cloud-auth";
import type { CreditBalanceResponse } from "../types/cloud";

let cache: { value: number; at: number } | null = null;
const TTL = 60_000;

export const creditBalanceProvider: Provider = {
  name: "elizacloud_credits",
  description: "ElizaCloud credit balance",
  dynamic: true,
  position: 91,

  async get(
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    const auth = runtime.getService("CLOUD_AUTH") as
      | CloudAuthService
      | undefined;
    if (!auth?.isAuthenticated()) return { text: "" };

    if (cache && Date.now() - cache.at < TTL) return format(cache.value);

    const { data } = await auth
      .getClient()
      .get<CreditBalanceResponse>("/credits/balance");
    cache = { value: data.balance, at: Date.now() };

    if (data.balance < 1.0)
      logger.warn(`[CloudCredits] Low balance: $${data.balance.toFixed(2)}`);
    return format(data.balance);
  },
};

function format(balance: number): ProviderResult {
  const low = balance < 2.0;
  const critical = balance < 0.5;
  let text = `ElizaCloud credits: $${balance.toFixed(2)}`;
  if (critical) text += " (CRITICAL)";
  else if (low) text += " (LOW)";
  return {
    text,
    values: {
      cloudCredits: balance,
      cloudCreditsLow: low,
      cloudCreditsCritical: critical,
    },
  };
}
