import { Action, HandlerCallback, IAgentRuntime, Memory, State, TransactionInputSchema } from "../types.js";
import { BaseGuardEngine } from "../engine.js";

export function createValidateTransactionAction(engine: BaseGuardEngine): Action {
  return {
    name: "VALIDATE_TRANSACTION",
    description: "Evaluates an onchain EVM/Base transaction before signing or dispatching. Checks spend caps, unlimited approvals, recipient blocklists, and prompt injection.",
    similes: [
      "CHECK_TRANSACTION_SAFETY",
      "AUDIT_CALLED_TRANSACTION",
      "INSPECT_TRANSFER",
      "VERIFY_ONCHAIN_ACTION",
    ],
    examples: [
      [
        {
          user: "{{user1}}",
          content: { text: "Transfer 0.01 ETH to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e" },
        },
        {
          user: "{{agentName}}",
          content: {
            text: "Running pre-flight security evaluation on the planned transfer...",
            action: "VALIDATE_TRANSACTION",
          },
        },
      ],
    ],
    validate: async (_runtime: IAgentRuntime, _message: Memory, _state?: State) => true,
    handler: async (
      _runtime: IAgentRuntime,
      message: Memory,
      _state?: State,
      options?: Record<string, unknown>,
      callback?: HandlerCallback
    ) => {
      const payload = {
        to: (options?.to || message.content?.to || "") as string,
        value: (options?.value || message.content?.value || "0") as string,
        data: (options?.data || message.content?.data || "0x") as string,
        userPrompt: message.content?.text || "",
        reasoningTrace: (options?.reasoning || "") as string,
      };

      const parseResult = TransactionInputSchema.safeParse(payload);
      if (!parseResult.success) {
        const errorText = `[BaseGuard BLOCKED]: Invalid transaction parameters: ${parseResult.error.message}`;
        if (callback) await callback({ text: errorText });
        return { allowed: false, error: errorText };
      }

      const verdict = engine.evaluateTransaction(parseResult.data);
      const outputText = verdict.allowed
        ? `[BaseGuard APPROVED]: ${verdict.reason}`
        : `[BaseGuard BLOCKED]: Code: ${verdict.code} | Risk: ${verdict.riskScore}/100 | ${verdict.reason}`;

      if (callback) {
        await callback({
          text: outputText,
          verdict,
        });
      }

      return verdict;
    },
  };
}
