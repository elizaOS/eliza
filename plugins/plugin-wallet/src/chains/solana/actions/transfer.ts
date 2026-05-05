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
  parseKeyValueXml,
  type State,
} from "@elizaos/core";
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { getWalletKey } from "../keypairUtils";
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

import { transferTemplate } from "../generated/prompts/typescript/prompts.js";
import { requireActionSpec } from "../generated/specs/spec-helpers";

const spec = requireActionSpec("TRANSFER");

export default {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions
  ): Promise<boolean> => {
    const keywords = ["transfer", "send", "give", "pay", "sol", "token"];
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
    _message: Memory,
    state: State,
    options: Record<string, string | number | boolean> | undefined,
    callback?: HandlerCallback
  ): Promise<undefined | ActionResult | undefined> => {
    // ... handler implementation ... (preserved)
    const transferPrompt = composePromptFromState({
      state,
      template: transferTemplate,
    });

    const result = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: transferPrompt,
    });

    const content = parseKeyValueXml(result) ?? parseJSONObjectFromText(result);

    if (!content) {
      if (callback) {
        callback({
          text: "Need a valid recipient address and amount to transfer.",
          content: { error: "Invalid transfer content" },
        });
      }
      return;
    }

    if (!isTransferContent(content)) {
      if (callback) {
        callback({
          text: "Need a valid recipient address and amount to transfer.",
          content: { error: "Invalid transfer content" },
        });
      }
      return;
    }

    if (!isConfirmed(options)) {
      const tokenLabel = content.tokenAddress === null ? "SOL" : content.tokenAddress;
      const preview = `Review Solana transfer before submitting: ${content.amount} ${tokenLabel} to ${content.recipient}. Re-invoke ${spec.name} with confirmed: true to submit.`;
      return confirmationRequired({
        actionName: spec.name,
        preview,
        parameters: {
          tokenAddress: content.tokenAddress,
          recipient: content.recipient,
          amount: content.amount,
        },
        callback,
      });
    }

    try {
      const { keypair: senderKeypair } = await getWalletKey(runtime, true);
      if (!senderKeypair) {
        if (callback) {
          callback({
            text: "Need a valid agent address.",
            content: { error: "Invalid transfer content" },
          });
        }
        return;
      }
      const rpcUrl = runtime.getSetting("SOLANA_RPC_URL");
      const rpcUrlStr = typeof rpcUrl === "string" ? rpcUrl : "https://api.mainnet-beta.solana.com";
      const connection = new Connection(rpcUrlStr);
      const recipientPubkey = new PublicKey(content.recipient);

      let signature: string;

      if (content.tokenAddress === null) {
        const lamports = Number(content.amount) * 1e9;

        const instruction = SystemProgram.transfer({
          fromPubkey: senderKeypair.publicKey,
          toPubkey: recipientPubkey,
          lamports,
        });

        const messageV0 = new TransactionMessage({
          payerKey: senderKeypair.publicKey,
          recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
          instructions: [instruction],
        }).compileToV0Message();

        const transaction = new VersionedTransaction(messageV0);
        transaction.sign([senderKeypair]);

        signature = await connection.sendTransaction(transaction);

        if (callback) {
          callback({
            text: `Sent ${content.amount} SOL. Transaction hash: ${signature}`,
            content: {
              success: true,
              signature,
              amount: content.amount,
              recipient: content.recipient,
            },
          });
        }
      } else {
        const mintPubkey = new PublicKey(content.tokenAddress);
        const mintInfo = await connection.getParsedAccountInfo(mintPubkey);
        const mintInfoValue = mintInfo.value;
        const mintInfoData =
          mintInfoValue && (mintInfoValue.data as { parsed: { info: { decimals: number } } });
        const decimals = mintInfoData?.parsed?.info?.decimals ?? 9;
        const adjustedAmount = BigInt(Number(content.amount) * 10 ** decimals);

        const senderATA = getAssociatedTokenAddressSync(mintPubkey, senderKeypair.publicKey);
        const recipientATA = getAssociatedTokenAddressSync(mintPubkey, recipientPubkey);

        const instructions: TransactionInstruction[] = [];

        const recipientATAInfo = await connection.getAccountInfo(recipientATA);
        if (!recipientATAInfo) {
          instructions.push(
            createAssociatedTokenAccountInstruction(
              senderKeypair.publicKey,
              recipientATA,
              recipientPubkey,
              mintPubkey
            )
          );
        }

        instructions.push(
          createTransferInstruction(
            senderATA,
            recipientATA,
            senderKeypair.publicKey,
            adjustedAmount
          )
        );

        const messageV0 = new TransactionMessage({
          payerKey: senderKeypair.publicKey,
          recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
          instructions,
        }).compileToV0Message();

        const transaction = new VersionedTransaction(messageV0);
        transaction.sign([senderKeypair]);

        signature = await connection.sendTransaction(transaction);

        if (callback) {
          callback({
            text: `Sent ${content.amount} tokens to ${content.recipient}\nTransaction hash: ${signature}`,
            content: {
              success: true,
              signature,
              amount: content.amount,
              recipient: content.recipient,
            },
          });
        }
      }

      return;
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
      return;
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
