import {
  type Action,
  type ActionExample,
  type ActionResult,
  type Content,
  composePromptFromState,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
  type State,
  withStandaloneTrajectory,
} from "@elizaos/core";
import { runIntentModel } from "../../../utils/intent-trajectory";
import { SOLANA_SERVICE_NAME } from "../constants";
import type { SolanaService, SolanaTransferParams, SolanaTransferResult } from "../service";
import { confirmationRequired, isConfirmed } from "./confirmation";

interface TransferContent extends Content {
  tokenAddress: string | null;
  recipient: string;
  amount: string | number;
}

function isTransferContent(content: unknown): content is TransferContent {
  if (!content || typeof content !== "object") return false;

  const c = content as Partial<Record<keyof TransferContent, unknown>>;
  if (typeof c.recipient !== "string") return false;
  if (!(typeof c.amount === "string" || typeof c.amount === "number")) return false;

  // Don’t mutate here; just validate. Treat 'null' as valid string; normalize later.
  if (c.tokenAddress !== null && typeof c.tokenAddress !== "string") return false;

  return true;
}

function normalizeTokenAddress(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "null" || trimmed.toUpperCase() === "SOL") {
    return null;
  }
  return trimmed;
}

async function extractTransferContent(runtime: IAgentRuntime, prompt: string): Promise<unknown> {
  const result = await withStandaloneTrajectory(
    runtime,
    {
      source: "solana.transfer.extract",
      metadata: {
        action: spec.name,
        purpose: "financial_parameter_extraction",
      },
    },
    () =>
      runIntentModel({
        runtime,
        taskName: "solana.transfer.intent",
        template: prompt,
        modelType: ModelType.TEXT_LARGE,
      })
  );

  return parseJSONObjectFromText(result);
}

/**
 * Read the recent-messages memory array that `recentMessagesProvider`
 * writes into `state.data.providers.RECENT_MESSAGES.data.recentMessages`.
 *
 * That path is the only location the runtime populates — `state.recentMessages`
 * and `state.recentMessagesData` don't exist on the `State` type and are
 * always `undefined`.
 */
function recentMessagesFromState(state: State | undefined): unknown[] {
  const messages = state?.data?.providers?.RECENT_MESSAGES?.data?.recentMessages;
  return Array.isArray(messages) ? messages : [];
}

function selectedContextMatches(state: State | undefined, contexts: readonly string[]): boolean {
  const selected = new Set<string>();
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === "string") selected.add(item);
    }
  };
  collect((state?.values as Record<string, unknown> | undefined)?.selectedContexts);
  collect((state?.data as Record<string, unknown> | undefined)?.selectedContexts);
  const contextObject = (state?.data as Record<string, unknown> | undefined)?.contextObject as
    | {
        trajectoryPrefix?: { selectedContexts?: unknown };
        metadata?: { selectedContexts?: unknown };
      }
    | undefined;
  collect(contextObject?.trajectoryPrefix?.selectedContexts);
  collect(contextObject?.metadata?.selectedContexts);
  return contexts.some((context) => selected.has(context));
}

import { transferTemplate } from "../generated/prompts/typescript/prompts.js";
import { requireActionSpec } from "../generated/specs/spec-helpers";

const spec = requireActionSpec("SOLANA_TRANSFER");

export default {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  contexts: ["finance", "crypto", "wallet", "payments"],
  contextGate: { anyOf: ["finance", "crypto", "wallet", "payments"] },
  roleGate: { minRole: "USER" },
  parameters: [
    {
      name: "amount",
      description: "Human-readable SOL or SPL token amount.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "recipient",
      description: "Recipient Solana address.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "fromToken",
      description: "Token symbol, mint address, or SOL.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "confirmed",
      description: "Set true after preview confirmation to submit.",
      required: false,
      schema: { type: "boolean", default: false },
    },
  ],
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions
  ): Promise<boolean> => {
    if (!runtime.getService(SOLANA_SERVICE_NAME)) {
      return false;
    }

    if (selectedContextMatches(state, ["finance", "crypto", "wallet", "payments"])) {
      return true;
    }
    const keywords = [
      "transfer",
      "send",
      "give",
      "pay",
      "sol",
      "token",
      "wallet",
      "crypto",
      "recipient",
      "address",
      "transfiere",
      "enviar",
      "pagar",
      "billetera",
      "transférer",
      "envoyer",
      "payer",
      "portefeuille",
      "überweisen",
      "senden",
      "zahlen",
      "wallet",
      "trasferisci",
      "invia",
      "paga",
      "転送",
      "送金",
      "支払",
      "转账",
      "发送",
      "支付",
      "송금",
      "보내",
      "지불",
    ];
    const currentText =
      typeof message.content?.text === "string" ? message.content.text.toLowerCase() : "";
    if (keywords.some((keyword) => currentText.includes(keyword))) {
      return true;
    }
    const recentMessages = recentMessagesFromState(state);
    return recentMessages.some((recent) => {
      if (!recent || typeof recent !== "object") {
        return false;
      }
      const content = (recent as { content?: unknown }).content;
      const recentText =
        typeof content === "string"
          ? content.toLowerCase()
          : content &&
              typeof content === "object" &&
              typeof (content as { text?: unknown }).text === "string"
            ? (content as { text: string }).text.toLowerCase()
            : "";
      return keywords.some((keyword) => recentText.includes(keyword));
    });
  },
  description: spec.description,
  descriptionCompressed: spec.descriptionCompressed,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options: Record<string, string | number | boolean> | undefined,
    callback?: HandlerCallback
  ): Promise<undefined | ActionResult | undefined> => {
    if (!state) {
      state = await runtime.composeState(message, ["RECENT_MESSAGES"]);
    }

    const transferPrompt = composePromptFromState({
      state,
      template: transferTemplate,
    });

    const content = await extractTransferContent(runtime, transferPrompt);

    if (!content) {
      if (callback) {
        callback({
          text: "Need a valid recipient address and amount to transfer.",
          content: { error: "Invalid transfer content" },
        });
      }
      return {
        success: false,
        text: "Need a valid recipient address and amount to transfer.",
        error: "Invalid transfer content",
      };
    }

    if (!isTransferContent(content)) {
      if (callback) {
        callback({
          text: "Need a valid recipient address and amount to transfer.",
          content: { error: "Invalid transfer content" },
        });
      }
      return {
        success: false,
        text: "Need a valid recipient address and amount to transfer.",
        error: "Invalid transfer content",
      };
    }

    const transferParams: SolanaTransferParams = {
      tokenAddress: normalizeTokenAddress(content.tokenAddress),
      recipient: content.recipient,
      amount: content.amount,
    };

    if (!isConfirmed(options)) {
      const tokenLabel = transferParams.tokenAddress === null ? "SOL" : transferParams.tokenAddress;
      const preview = `Review Solana transfer before submitting: ${content.amount} ${tokenLabel} to ${content.recipient}. Re-invoke ${spec.name} with confirmed: true to submit.`;
      return confirmationRequired({
        actionName: spec.name,
        preview,
        parameters: {
          tokenAddress: transferParams.tokenAddress,
          recipient: transferParams.recipient,
          amount: transferParams.amount,
        },
        callback,
      });
    }

    try {
      const solanaService = runtime.getService(SOLANA_SERVICE_NAME) as SolanaService | null;
      if (!solanaService) {
        throw new Error("SolanaService not initialized");
      }

      const walletResult = await solanaService.handleWalletAction({
        subaction: "transfer",
        chain: "solana",
        ...transferParams,
        mode: options?.dryRun === true ? "prepare" : "execute",
        dryRun: options?.dryRun === true,
      });
      if (!("kind" in walletResult)) {
        throw new Error("SolanaService returned a non-transfer wallet action result");
      }
      const transferResult: SolanaTransferResult = walletResult;

      if (callback) {
        const tokenLabel = transferResult.kind === "sol" ? "SOL" : "tokens";
        callback({
          text: transferResult.dryRun
            ? `Solana transfer dry run completed for ${transferResult.amount} ${tokenLabel}.`
            : `Sent ${transferResult.amount} ${tokenLabel}. Transaction hash: ${transferResult.signature}`,
          content: {
            success: true,
            signature: transferResult.signature,
            dryRun: transferResult.dryRun,
            amount: transferResult.amount,
            recipient: transferResult.recipient,
          },
        });
      }

      return {
        success: true,
        text: transferResult.dryRun
          ? `Solana transfer dry run completed for ${transferResult.amount} ${transferResult.kind === "sol" ? "SOL" : "tokens"}.`
          : `Sent ${transferResult.amount} ${transferResult.kind === "sol" ? "SOL" : "tokens"}. Transaction hash: ${transferResult.signature}`,
        values: {
          success: true,
          signature: transferResult.signature,
          dryRun: transferResult.dryRun,
          amount: transferResult.amount,
          recipient: transferResult.recipient,
        },
        data: transferResult,
      };
    } catch (error) {
      logger.error({ error }, "Error during transfer");
      if (callback) {
        const message =
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : JSON.stringify(error);
        callback({
          text: `Transfer failed: ${message}`,
          content: { error: message },
        });
      }
      return {
        success: false,
        text: `Transfer failed: ${
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : JSON.stringify(error)
        }`,
        error:
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : JSON.stringify(error),
      };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Transfer 1 SOL to @recipient",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll transfer 1 SOL to @recipient now.",
          action: "TRANSFER",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Send 100 USDC to 0x...",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Sending 100 USDC to 0x... immediately.",
          action: "TRANSFER",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Please remit payment for the audit services immediately.",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I am processing the payment for the audit services now.",
          action: "TRANSFER",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Transfiere 50 USDT a esta dirección",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Entendido, voy a transferir 50 USDT a esa dirección.",
          action: "TRANSFER",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "给这个钱包转 0.2 SOL",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "好的，我现在转 0.2 SOL 到该钱包。",
          action: "TRANSFER",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Pay contractor with 250 USDC and confirm the transaction hash",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Processing a 250 USDC transfer and I’ll return the tx hash once submitted.",
          action: "TRANSFER",
        },
      },
    ],
  ] as ActionExample[][],
} as Action;
