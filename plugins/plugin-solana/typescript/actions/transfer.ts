import {
  type Action,
  type ActionExample,
  type ActionResult,
  type Content,
  composePromptFromState,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
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
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { getWalletKey } from "../keypairUtils";

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

import { transferTemplate } from "../generated/prompts/typescript/prompts.js";
import { requireActionSpec } from "../generated/specs/spec-helpers";

const spec = requireActionSpec("TRANSFER");

export default {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  validate: async () => {
    return true;
  },
  description: spec.description,
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state: State,
    _options: Record<string, string | number | boolean>,
    callback?: HandlerCallback
  ): Promise<undefined | ActionResult | undefined> => {
    const transferPrompt = composePromptFromState({
      state,
      template: transferTemplate,
    });

    const result = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: transferPrompt,
    });

    const content = parseJSONObjectFromText(result);

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

        const instructions = [];

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

  examples: (spec.examples ?? []) as ActionExample[][],
} as Action;
