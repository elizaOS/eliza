import { type Action, type IAgentRuntime, type Memory, type State, type HandlerCallback, logger } from "@elizaos/core";
import type { CanaryGuardResult, CanaryGuardConfig } from "../types";

export const CANARYGUARD_DEFAULT_URL = "https://canaryguard-402.onrender.com";

export async function callCanaryGuardSanitize(
  content: string,
  config: CanaryGuardConfig = {}
): Promise<CanaryGuardResult> {
  const host = (
    config.serviceUrl ||
    process.env.CANARYGUARD_URL ||
    CANARYGUARD_DEFAULT_URL
  ).replace(/\/$/, "");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const payment = config.paymentHeader || process.env.CANARYGUARD_PAYMENT_HEADER;
  if (payment) {
    headers["PAYMENT-SIGNATURE"] = payment;
    headers["X-PAYMENT"] = payment;
  }

  const res = await fetch(`${host}/v1/sanitize`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      content,
      strict_mode: config.strictMode !== false,
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`CanaryGuard HTTP ${res.status}: ${errorBody}`);
  }

  return (await res.json()) as CanaryGuardResult;
}

export const sanitizeAction: Action = {
  name: "CANARY_SANITIZE",
  similes: ["SANITIZE_TEXT", "CHECK_INJECTION", "FIREWALL_CHECK", "VERIFY_INPUT_SAFETY"],
  description: "Runs untrusted text, user messages, or tool outputs through CanaryGuard 402 on Base mainnet to scrub prompt injection, concealed Unicode, and wallet drain commands.",
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    return Boolean(message?.content?.text);
  },
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: Record<string, any>,
    callback?: HandlerCallback
  ): Promise<boolean | CanaryGuardResult> => {
    try {
      const text = message.content?.text || "";
      const result = await callCanaryGuardSanitize(text, options);

      if (callback) {
        callback({
          text: `[CanaryGuard 402] Status: ${result.status.toUpperCase()} | Risk: ${(result.risk_score * 100).toFixed(0)}% | Neutralized: ${result.threats_neutralized.length} threats`,
          content: {
            canaryguard: result,
          },
        });
      }
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`CanaryGuard sanitization error: ${msg}`);
      if (callback) {
        callback({ text: `CanaryGuard check failed: ${msg}` });
      }
      return false;
    }
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: { text: "Scan this suspicious webhook payload for hidden jailbreak instructions" },
      },
      {
        user: "{{agentName}}",
        content: {
          text: "Running CanaryGuard 402 prompt-injection firewall...",
          action: "CANARY_SANITIZE",
        },
      },
    ],
  ],
};
