import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { StewardService } from "../services/StewardService.js";

/**
 * STEWARD_SIGN_TRANSACTION — routes a transaction through Steward's
 * policy engine and signing vault.
 *
 * The LLM extracts `to`, `value`, optional `data`, and `chainId` from
 * conversation context. The action validates connectivity, submits to
 * Steward, and returns one of: success (txHash), pending_approval, or
 * policy rejection.
 */
export const signTransactionAction: Action = {
  name: "STEWARD_SIGN_TRANSACTION",
  description:
    "Sign and broadcast a transaction through Steward's managed wallet with policy enforcement",
  similes: ["sign transaction", "send transaction", "execute transaction", "broadcast transaction"],

  parameters: [
    {
      name: "to",
      description: "Destination address (0x… for EVM)",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "value",
      description: "Amount in wei (EVM) or lamports (Solana)",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "data",
      description: "Calldata for contract interactions (hex-encoded)",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "chainId",
      description: "Target chain ID (e.g. 8453 for Base, 1 for Ethereum mainnet)",
      required: false,
      schema: { type: "number" },
    },
  ],

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Sign a transaction sending 0.01 ETH to 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 on Base",
          action: "STEWARD_SIGN_TRANSACTION",
        },
      },
    ],
  ] as ActionExample[][],

  async validate(runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> {
    const steward = runtime.getService("steward" as any) as StewardService | null;
    return steward?.isConnected() ?? false;
  },

  async handler(
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: HandlerOptions,
  ): Promise<ActionResult> {
    const steward = runtime.getService("steward" as any) as StewardService;
    const params = options?.parameters;

    if (!params?.to || !params?.value) {
      return {
        success: false,
        error: "Missing required parameters: 'to' and 'value'",
        text: "I need both a destination address and an amount to sign a transaction.",
      };
    }

    try {
      const result = await steward.signTransaction({
        to: params.to as string,
        value: params.value as string,
        data: (params.data as string) ?? undefined,
        chainId: (params.chainId as number) ?? undefined,
      });

      if ("txHash" in result) {
        return {
          success: true,
          text: `Transaction signed and broadcast. Hash: ${result.txHash}`,
          data: { txHash: result.txHash },
        };
      }

      if ("status" in result && result.status === "pending_approval") {
        return {
          success: true,
          text: "Transaction requires manual approval. Waiting for the wallet owner to approve.",
          data: {
            status: "pending_approval",
            policies: result.results as any,
          },
        };
      }

      if ("signedTx" in result) {
        return {
          success: true,
          text: `Transaction signed (not broadcast). Signed tx: ${result.signedTx}`,
          data: { signedTx: result.signedTx },
        };
      }

      return {
        success: false,
        error: "Unexpected response from Steward",
        text: "Transaction could not be processed.",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: msg,
        text: `Transaction rejected: ${msg}`,
        data: { error: msg },
      };
    }
  },
};
