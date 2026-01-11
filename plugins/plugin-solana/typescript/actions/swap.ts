import {
  type Action,
  type ActionExample,
  type ActionResult,
  composePromptFromState,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
  type State,
} from "@elizaos/core";
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import BigNumber, { type BigNumber as BigNumberType } from "../bn";
import { SOLANA_SERVICE_NAME } from "../constants";
import { getWalletKey } from "../keypairUtils";
import type { SolanaService } from "../service";

import type { Item } from "../types";

/**
 * Fetches the number of decimals for a given token mint address.
 *
 * @param {Connection} connection - Solana connection object.
 * @param {string} mintAddress - Address of the token mint.
 * @returns {Promise<number>} - Number of decimals for the token.
 * @throws {Error} - If unable to fetch token decimals.
 */
async function getTokenDecimals(connection: Connection, mintAddress: string): Promise<number> {
  const mintPublicKey = new PublicKey(mintAddress);
  const tokenAccountInfo = await connection.getParsedAccountInfo(mintPublicKey);

  if (
    tokenAccountInfo.value &&
    typeof tokenAccountInfo.value.data === "object" &&
    "parsed" in tokenAccountInfo.value.data
  ) {
    const parsedInfo = tokenAccountInfo.value.data.parsed?.info;
    if (parsedInfo && typeof parsedInfo.decimals === "number") {
      return parsedInfo.decimals;
    }
  }

  throw new Error("Unable to fetch token decimals");
}

/**
 * Swaps tokens using the specified connection, wallet public key, input and output token contract addresses,
 * and amount. Returns a Promise that resolves to the swap data.
 *
 * @param {Connection} connection The connection object to use for interacting with the blockchain.
 * @param {PublicKey} walletPublicKey The public key of the wallet initiating the swap.
 * @param {string} inputTokenCA The contract address of the input token.
 * @param {string} outputTokenCA The contract address of the output token.
 * @param {number} amount The amount of tokens to swap.
 * @returns {Promise<unknown>} A Promise that resolves to the swap data object.
 */
async function swapToken(
  connection: Connection,
  walletPublicKey: PublicKey,
  inputTokenCA: string,
  outputTokenCA: string,
  amount: number
): Promise<unknown> {
  try {
    // Validate SOL_ADDRESS if we're comparing against it
    let decimals: BigNumberType;
    if (process.env.SOL_ADDRESS && inputTokenCA === process.env.SOL_ADDRESS) {
      decimals = new BigNumber(9);
    } else {
      decimals = new BigNumber(await getTokenDecimals(connection, inputTokenCA));
    }

    logger.log("Decimals:", decimals.toString());

    const amountBN = new BigNumber(amount);
    const adjustedAmount = amountBN.multipliedBy(new BigNumber(10).pow(decimals));

    logger.log(
      {
        inputMint: inputTokenCA,
        outputMint: outputTokenCA,
        amount: adjustedAmount,
      },
      "Fetching quote with params:"
    );

    const quoteResponse = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=${inputTokenCA}&outputMint=${outputTokenCA}&amount=${adjustedAmount}&dynamicSlippage=true&maxAccounts=64`
    );
    const quoteData = (await quoteResponse.json()) as {
      error?: string;
    };

    if (!quoteData || quoteData.error) {
      logger.error({ quoteData }, "Quote error");
      throw new Error(`Failed to get quote: ${quoteData?.error || "Unknown error"}`);
    }

    const swapRequestBody = {
      quoteResponse: quoteData,
      userPublicKey: walletPublicKey.toBase58(),
      dynamicComputeUnitLimit: true,
      dynamicSlippage: true,
      priorityLevelWithMaxLamports: {
        maxLamports: 4000000,
        priorityLevel: "veryHigh",
      },
    };

    const swapResponse = await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(swapRequestBody),
    });

    const swapData = (await swapResponse.json()) as {
      error?: string;
      swapTransaction?: string;
    };

    if (!swapData || !swapData.swapTransaction) {
      logger.error({ swapData }, "Swap error");
      throw new Error(
        `Failed to get swap transaction: ${swapData?.error || "No swap transaction returned"}`
      );
    }

    return swapData;
  } catch (error) {
    logger.error({ error }, "Error in swapToken:");
    throw error;
  }
}

// Get token from wallet data using SolanaService
/**
 * Retrieves the token address from the wallet for the specified token symbol.
 *
 * @param {IAgentRuntime} runtime - The agent runtime.
 * @param {string} tokenSymbol - The token symbol to retrieve the address for.
 * @returns {Promise<string|null>} The token address if found, null otherwise.
 */
async function getTokenFromWallet(
  runtime: IAgentRuntime,
  tokenSymbol: string
): Promise<string | null> {
  try {
    const solanaService = runtime.getService(SOLANA_SERVICE_NAME) as SolanaService;
    if (!solanaService) {
      throw new Error("SolanaService not initialized");
    }

    const walletData = await solanaService.getCachedData();
    if (!walletData) {
      return null;
    }

    const token = walletData.items.find(
      (item: Item) => item.symbol.toLowerCase() === tokenSymbol.toLowerCase()
    );

    return token ? token.address : null;
  } catch (error) {
    logger.error({ error }, "Error checking token in wallet");
    return null;
  }
}

/**
 * Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.
 *
 * Example response:
 * ```json
 * {
 *     "inputTokenSymbol": "SOL",
 *     "outputTokenSymbol": "USDC",
 *     "inputTokenCA": "So11111111111111111111111111111111111111112",
 *     "outputTokenCA": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
 *     "amount": 1.5
 * }
 * ```
 *
 * {{recentMessages}}
 *
 * Given the recent messages and wallet information below:
 *
 * {{walletInfo}}
 *
 * Extract the following information about the requested token swap:
 * - Input token symbol (the token being sold)
 * - Output token symbol (the token being bought)
 * - Input token contract address if provided
 * - Output token contract address if provided
 * - Amount to swap
 *
 * Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.
 */
import { swapTemplate } from "../generated/prompts/typescript/prompts.js";

/**
 * Action for executing a token swap from one token to another on Solana.
 *
 * @type {Action}
 * @property {string} name - The name of the action ("SWAP_SOLANA").
 * @property {string[]} similes - Alternative names for the action.
 * @property {Function} validate - Asynchronous function to validate if Solana service is available.
 * @property {string} description - Description of the action.
 * @property {Function} handler - Asynchronous function to handle the token swap process.
 * @property {ActionExample[][]} examples - Examples demonstrating how to use the action.
 */

export const executeSwap: Action = {
  name: "SWAP_SOLANA",
  similes: [
    "SWAP_SOL",
    "SWAP_TOKENS_SOLANA",
    "TOKEN_SWAP_SOLANA",
    "TRADE_TOKENS_SOLANA",
    "EXCHANGE_TOKENS_SOLANA",
  ],
  validate: async (runtime: IAgentRuntime, _message: Memory) => {
    const solanaService = runtime.getService(SOLANA_SERVICE_NAME);
    return !!solanaService;
  },
  description:
    "Perform a token swap from one token to another on Solana. Works with SOL and SPL tokens.",
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options: { [key: string]: unknown } | undefined,
    callback?: HandlerCallback
  ): Promise<undefined | ActionResult | undefined> => {
    state = await runtime.composeState(message, ["RECENT_MESSAGES"]);

    try {
      const solanaService = runtime.getService(SOLANA_SERVICE_NAME) as SolanaService;
      if (!solanaService) {
        throw new Error("SolanaService not initialized");
      }

      const walletData = await solanaService.getCachedData();
      state.values.walletInfo = walletData;

      const swapPrompt = composePromptFromState({
        state,
        template: swapTemplate,
      });

      const result = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: swapPrompt,
      });

      const response = parseJSONObjectFromText(result) as {
        inputTokenSymbol?: string;
        outputTokenSymbol?: string;
        inputTokenCA?: string;
        outputTokenCA?: string;
        amount?: number;
      };

      // Handle SOL addresses - validate early and fail fast if not configured
      if (response.inputTokenSymbol?.toUpperCase() === "SOL") {
        if (!process.env.SOL_ADDRESS) {
          throw new Error(
            "SOL_ADDRESS is not configured. Please set SOL_ADDRESS in your environment variables to swap SOL tokens."
          );
        }
        response.inputTokenCA = process.env.SOL_ADDRESS;
      }
      if (response.outputTokenSymbol?.toUpperCase() === "SOL") {
        if (!process.env.SOL_ADDRESS) {
          throw new Error(
            "SOL_ADDRESS is not configured. Please set SOL_ADDRESS in your environment variables to swap SOL tokens."
          );
        }
        response.outputTokenCA = process.env.SOL_ADDRESS;
      }

      // Resolve token addresses if needed
      if (!response.inputTokenCA && response.inputTokenSymbol) {
        response.inputTokenCA =
          (await getTokenFromWallet(runtime, response.inputTokenSymbol)) || "";
        if (!response.inputTokenCA) {
          callback?.({ text: "Could not find the input token in your wallet" });
          return;
        }
      }

      if (!response.outputTokenCA && response.outputTokenSymbol) {
        response.outputTokenCA =
          (await getTokenFromWallet(runtime, response.outputTokenSymbol)) || "";
        if (!response.outputTokenCA) {
          callback?.({
            text: "Could not find the output token in your wallet",
          });
          return;
        }
      }

      if (!response.amount) {
        callback?.({ text: "Please specify the amount you want to swap" });
        return;
      }

      const rpcUrl = runtime.getSetting("SOLANA_RPC_URL");
      const rpcUrlStr = typeof rpcUrl === "string" ? rpcUrl : "https://api.mainnet-beta.solana.com";
      const connection = new Connection(rpcUrlStr);
      const { publicKey: walletPublicKey } = await getWalletKey(runtime, false);

      const swapResult = (await swapToken(
        connection,
        walletPublicKey as PublicKey,
        response.inputTokenCA as string,
        response.outputTokenCA as string,
        response.amount as number
      )) as { swapTransaction: string };

      const transactionBuf = Buffer.from(swapResult.swapTransaction, "base64");
      const transaction = VersionedTransaction.deserialize(transactionBuf);

      const { keypair } = await getWalletKey(runtime, true);
      if (keypair?.publicKey.toBase58() !== walletPublicKey?.toBase58()) {
        throw new Error("Generated public key doesn't match expected public key");
      }

      if (keypair) {
        transaction.sign([keypair]);
      } else {
        throw new Error("Keypair not found");
      }

      const latestBlockhash = await connection.getLatestBlockhash();
      const txid = await connection.sendTransaction(transaction, {
        skipPreflight: false,
        maxRetries: 3,
        preflightCommitment: "confirmed",
      });

      const confirmation = await connection.confirmTransaction(
        {
          signature: txid,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        },
        "confirmed"
      );

      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${confirmation.value.err}`);
      }

      callback?.({
        text: `Swap completed successfully! Transaction ID: ${txid}`,
        content: { success: true, txid },
      });

      return;
    } catch (error) {
      if (error instanceof Error) {
        logger.error({ error }, "Error during token swap");
        callback?.({
          text: `Swap failed: ${error.message}`,
          content: { error: error.message },
        });
        return;
      }
      throw error;
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Swap 0.1 SOL for USDC",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll help you swap 0.1 SOL for USDC",
          actions: ["SWAP_SOLANA"],
        },
      },
    ],
  ] as ActionExample[][],
};
