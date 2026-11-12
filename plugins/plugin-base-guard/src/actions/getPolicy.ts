import { Action, HandlerCallback, IAgentRuntime, Memory, State } from "../types.js";
import { BaseGuardEngine } from "../engine.js";

export function createGetPolicyAction(engine: BaseGuardEngine): Action {
  return {
    name: "GET_SECURITY_POLICY",
    description: "Returns the active onchain spending limits, token caps, and safety rules for the agent.",
    similes: ["CHECK_LIMITS", "GET_SPEND_CEILINGS", "VIEW_SECURITY_RULES"],
    examples: [
      [
        {
          name: "{{user1}}",
          content: { text: "What are your spending limits on Base?" },
        },
        {
          name: "{{agentName}}",
          content: { text: "Checking active security policy boundaries...", action: "GET_SECURITY_POLICY" },
        },
      ],
    ],
    validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State) => {
      const text = message.content?.text || "";
      return /(?:limit|ceiling|spend|policy|security)/i.test(text);
    },
    handler: async (
      _runtime: IAgentRuntime,
      _message: Memory,
      _state?: State,
      _options?: Record<string, unknown>,
      callback?: HandlerCallback
    ) => {
      const policy = engine.getPolicy();
      const text = `Current Onchain Security Policy:\n` +
        `• Max Native / Tx: ${policy.maxNativePerTx} ETH\n` +
        `• Max Native / 24h: ${policy.maxNativeDaily} ETH\n` +
        `• Max USDC / Tx: ${policy.maxUsdcPerTx} USDC\n` +
        `• Max USDC / 24h: ${policy.maxUsdcDaily} USDC\n` +
        `• Max x402 Payment: ${policy.maxPaymentPerX402} USDC\n` +
        `• Strict Injection Defense: ${policy.strictMode ? "ENABLED" : "DISABLED"}`;

      if (callback) await callback({ text });
      return {
        success: true,
        text,
        ...policy,
      };
    },
  };
}
