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

/**
 * Interface representing the content of a transfer.
 *
 * @interface TransferContent
 * @extends Content
 * @property {string | null} tokenAddress - The address of the token being transferred, or null for SOL transfers
 * @property {string} recipient - The address of the recipient of the transfer
 * @property {string | number} amount - The amount of the transfer, represented as a string or number
 */
interface TransferContent extends Content {
  tokenAddress: string | null; // null for SOL transfers
  recipient: string;
  amount: string | number;
}

/**
 * Checks if the given transfer content is valid based on the type of transfer.
 * @param {TransferContent} content - The content to be validated for transfer.
 * @returns {boolean} Returns true if the content is valid for transfer, and false otherwise.
 */
function isTransferContent(content: unknown): content is TransferContent {
  if (!content || typeof content !== "object") return false;

  const c = content as Partial<Record<keyof TransferContent, unknown>>;
  // Base validation
  if (typeof c.recipient !== "string") return false;
  if (!(typeof c.amount === "string" || typeof c.amount === "number"))
    return false;

  // Don’t mutate here; just validate. Treat 'null' as valid string; normalize later.
  if (c.tokenAddress !== null && typeof c.tokenAddress !== "string")
    return false;

  return true;
}

/**
 * Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.
 *
 * Example responses:
 * For SPL tokens:
 * ```json
 * {
 *    "tokenAddress": "BieefG47jAHCGZBxi2q87RDuHyGZyYC3vAzxpyu8pump",
 *    "recipient": "9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa",
 *    "amount": "1000"
 * }
 * ```
 *
 * For SOL:
 * ```json
 * {
 *    "tokenAddress": null,
 *    "recipient": "9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa",
 *    "amount": 1.5
 * }
 * ```
 *
 * {{recentMessages}}
 *
 * Extract the following information about the requested transfer:
 * - Token contract address (use null for SOL transfers)
 * - Recipient wallet address
 * - Amount to transfer
 */
const transferTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example responses:
For SPL tokens:
\`\`\`json
{
    "tokenAddress": "BieefG47jAHCGZBxi2q87RDuHyGZyYC3vAzxpyu8pump",
    "recipient": "9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa",
    "amount": "1000"
}
\`\`\`

For SOL:
\`\`\`json
{
    "tokenAddress": null,
    "recipient": "9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa",
    "amount": 1.5
}
\`\`\`

{{recentMessages}}

Extract the following information about the requested transfer:
- Token contract address (use null for SOL transfers)
- Recipient wallet address
- Amount to transfer
`;

export default {
  name: "TRANSFER_SOLANA",
  similes: [
    "TRANSFER_SOL",
    "SEND_TOKEN_SOLANA",
    "TRANSFER_TOKEN_SOLANA",
    "SEND_TOKENS_SOLANA",
    "TRANSFER_TOKENS_SOLANA",
    "SEND_SOL",
    "SEND_TOKEN_SOL",
    "PAY_SOL",
    "PAY_TOKEN_SOL",
    "PAY_TOKENS_SOL",
    "PAY_TOKENS_SOLANA",
    "PAY_SOLANA",
  ],
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    runtime.logger.log("Validating transfer from entity:", message.entityId);
    return true;
  },
  description: "Transfer SOL or SPL tokens to another address on Solana.",
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state: State,
    _options: { [key: string]: unknown },
    callback?: HandlerCallback,
  ): Promise<undefined | ActionResult | undefined> => {
    logger.log("Starting TRANSFER handler...");

    const transferPrompt = composePromptFromState({
      state: state,
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

      // Handle SOL transfer
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
      }
      // Handle SPL token transfer
      else {
        const mintPubkey = new PublicKey(content.tokenAddress);
        const mintInfo = await connection.getParsedAccountInfo(mintPubkey);
        const mintInfoValue = mintInfo.value;
        const mintInfoData = mintInfoValue && mintInfoValue.data as { parsed: { info: { decimals: number } } };
        const decimals =
          (mintInfoData && mintInfoData.parsed && mintInfoData.parsed.info && mintInfoData.parsed.info.decimals) ?? 9;
        const adjustedAmount = BigInt(Number(content.amount) * 10 ** decimals);

        const senderATA = getAssociatedTokenAddressSync(
          mintPubkey,
          senderKeypair.publicKey,
        );
        const recipientATA = getAssociatedTokenAddressSync(
          mintPubkey,
          recipientPubkey,
        );

        const instructions = [];

        const recipientATAInfo = await connection.getAccountInfo(recipientATA);
        if (!recipientATAInfo) {
          instructions.push(
            createAssociatedTokenAccountInstruction(
              senderKeypair.publicKey,
              recipientATA,
              recipientPubkey,
              mintPubkey,
            ),
          );
        }

        instructions.push(
          createTransferInstruction(
            senderATA,
            recipientATA,
            senderKeypair.publicKey,
            adjustedAmount,
          ),
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
        name: "{{name1}}",
        content: {
          text: "Send 1.5 SOL to 9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Sending SOL now...",
          actions: ["TRANSFER_SOLANA"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Send 69 $DEGENAI BieefG47jAHCGZBxi2q87RDuHyGZyYC3vAzxpyu8pump to 9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Sending the tokens now...",
          actions: ["TRANSFER_SOLANA"],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;
