import type { Evaluator, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { hasAutoRejectFlag } from "../utils/flag-interpreter.js";
import { getTransactionRecommendation } from "../utils/recommendations.js";
import { extractDomain } from "../utils/domain.js";
import { getScoutClient, getScoutConfig } from "../runtime-store.js";

const TX_KEYWORDS = /\b(pay|send|transfer|usdc|escrow|x402|transaction|purchase|buy)\b/i;
const AMOUNT_REGEX = /\$(\d+(?:,\d{3})*(?:\.\d{1,2})?)\b|\b(\d+(?:,\d{3})*(?:\.\d{1,2})?)\s*(?:usdc|usd|dollars?)\b/i;

function extractAmount(text: string): number | undefined {
  const match = text.match(AMOUNT_REGEX);
  if (!match) return undefined;
  const raw = (match[1] || match[2]).replace(/,/g, "");
  return parseFloat(raw);
}

export const transactionGuardEvaluator: Evaluator = {
  name: "scout_transaction_guard",
  description:
    "Evaluates messages involving x402 transactions and warns or blocks based on service trust scores. Triggers on payment-related keywords.",
  similes: ["TRANSACTION_SAFETY", "PAYMENT_GUARD"],

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State
  ): Promise<boolean> => {
    const text = message.content.text || "";
    return TX_KEYWORDS.test(text) && extractDomain(text) !== null;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ) => {
    const text = message.content.text || "";
    const domain = extractDomain(text);
    if (!domain) return { success: true };

    const client = getScoutClient(runtime);
    const config = getScoutConfig(runtime);
    if (!client || !config) return { success: true };

    try {
      const result = await client.getServiceScore(domain);
      const { score, level, flags, recommendation } = result;
      const amount = extractAmount(text);

      // Check auto-reject flags
      if (hasAutoRejectFlag(flags, config.autoRejectFlags)) {
        const matchedFlags = flags.filter((f) => config.autoRejectFlags.includes(f));
        callback?.({
          text: `Transaction BLOCKED: ${domain} (score ${score}/100, ${level}) has auto-reject flags: ${matchedFlags.join(", ")}. ` +
            `This service is not safe for x402 payments.`,
        });
        return { success: true, data: { blocked: true, reason: "auto_reject_flags", flags: matchedFlags } };
      }

      // Check minimum score
      if (score < config.minServiceScore) {
        callback?.({
          text: `Transaction WARNING: ${domain} (score ${score}/100, ${level}) is below the minimum trust threshold of ${config.minServiceScore}. ` +
            `Verdict: ${recommendation.verdict}. Proceeding is not recommended.`,
        });
        return { success: true, data: { blocked: false, warning: true, reason: "below_min_score" } };
      }

      // Check transaction amount against recommendation
      const rec = getTransactionRecommendation(score, amount);
      if (amount !== undefined && !rec.safe) {
        callback?.({
          text: `Transaction advisory: ${domain} (score ${score}/100, ${level}) - ${rec.message}`,
        });
        return { success: true, data: { blocked: false, warning: true, reason: "exceeds_max_transaction" } };
      }

      // All clear
      if (amount !== undefined) {
        callback?.({
          text: `Transaction advisory: ${domain} (score ${score}/100, ${level}) - ${rec.message}`,
        });
      }

      return { success: true, data: { blocked: false, warning: false } };
    } catch {
      // If we can't reach Scout, note it but don't block
      callback?.({
        text: `Transaction advisory: Unable to verify trust for ${domain}. Scout may be temporarily unavailable. Proceed with caution.`,
      });
      return { success: true, data: { blocked: false, warning: true, reason: "api_unavailable" } };
    }
  },

  examples: [
    {
      prompt: "User wants to pay a service",
      messages: [
        { name: "User", content: { text: "Pay $500 to api.questflow.ai" } },
      ],
      outcome: "Evaluates the service trust and advises on transaction safety",
    },
  ],
};