/** Credit balance in agent state (60s cache). */

import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { CloudAuthService } from "../services/cloud-auth";
import type { CreditBalanceResponse } from "../types/cloud";

const TOP_UP_URL = "https://www.elizacloud.ai/dashboard/settings?tab=billing";
const creditCaches = new WeakMap<IAgentRuntime, { value: number; at: number }>();
const TTL = 60_000;
const MAX_CREDIT_TEXT_CHARS = 240;

export const creditBalanceProvider: Provider = {
  name: "elizacloud_credits",
  description: "ElizaCloud credit balance",
  descriptionCompressed: "ElizaCloud credit balance.",
  dynamic: true,
  contexts: ["settings", "finance"],
  contextGate: { anyOf: ["settings", "finance"] },
  cacheStable: false,
  cacheScope: "turn",
  position: 91,
  async get(runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> {
    const auth = runtime.getService("CLOUD_AUTH") as CloudAuthService | undefined;
    if (!auth?.isAuthenticated()) return { text: "" };

    const cached = creditCaches.get(runtime);
    if (cached && Date.now() - cached.at < TTL) {
      const result = format(cached.value);
      return { ...result, text: (result.text ?? "").slice(0, MAX_CREDIT_TEXT_CHARS) };
    }

    let balance: number;
    try {
      const { data } = await auth.getClient().get<CreditBalanceResponse>("/credits/balance");
      balance = data.balance;
    } catch (err) {
      logger.warn(
        `[CloudCredits] Failed to fetch balance: ${err instanceof Error ? err.message : err}`
      );
      if (cached) {
        const result = format(cached.value);
        return { ...result, text: (result.text ?? "").slice(0, MAX_CREDIT_TEXT_CHARS) };
      }
      return { text: "", values: { cloudCreditsUnavailable: true }, data: {} };
    }
    creditCaches.set(runtime, { value: balance, at: Date.now() });

    if (balance < 1.0) logger.warn(`[CloudCredits] Low balance: $${balance.toFixed(2)}`);
    const result = format(balance);
    return { ...result, text: result.text.slice(0, MAX_CREDIT_TEXT_CHARS) };
  },
};

function format(balance: number): ProviderResult {
  const low = balance < 2.0;
  const critical = balance < 0.5;
  let text = `ElizaCloud credits: $${balance.toFixed(2)}`;
  if (critical) text += ` (CRITICAL — top up at ${TOP_UP_URL})`;
  else if (low) text += ` (LOW — top up at ${TOP_UP_URL})`;
  return {
    text,
    values: {
      cloudCredits: balance,
      cloudCreditsLow: low,
      cloudCreditsCritical: critical,
      cloudTopUpUrl: TOP_UP_URL,
    },
  };
}
