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
import { requireActionSpec } from "../generated/specs/spec-helpers";
import { getWalletKey } from "../keypairUtils";
import type { SolanaService } from "../service";
import type { Item } from "../types";

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

async function swapToken(
  connection: Connection,
  walletPublicKey: PublicKey,
  inputTokenCA: string,
  outputTokenCA: string,
  amount: number
): Promise<{ swapTransaction: string; error?: string }> {
  try {
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
      swapTransaction?: string;
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
      [key: string]: string | number | boolean | undefined;
    };

    if (!swapData || !swapData.swapTransaction) {
      logger.error({ swapData }, "Swap error");
      throw new Error(
        `Failed to get swap transaction: ${swapData?.error || "No swap transaction returned"}`
      );
    }

    return {
      swapTransaction: swapData.swapTransaction,
      error: swapData.error,
    };
  } catch (error) {
    logger.error({ error }, "Error in swapToken:");
    throw error;
  }
}

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

import { swapTemplate } from "../generated/prompts/typescript/prompts.js";

const spec = requireActionSpec("SWAP");

export const executeSwap: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  validate: async (runtime: IAgentRuntime, _message: Memory) => {
    const solanaService = runtime.getService(SOLANA_SERVICE_NAME);
    return !!solanaService;
  },
  description: spec.description,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options: Record<string, string | number | boolean> | undefined,
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

      if (response.inputTokenSymbol?.toUpperCase() === "SOL") {
        if (!process.env.SOL_ADDRESS) {
          throw new Error("SOL_ADDRESS is not configured");
        }
        response.inputTokenCA = process.env.SOL_ADDRESS;
      }
      if (response.outputTokenSymbol?.toUpperCase() === "SOL") {
        if (!process.env.SOL_ADDRESS) {
          throw new Error("SOL_ADDRESS is not configured");
        }
        response.outputTokenCA = process.env.SOL_ADDRESS;
      }
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

      const swapResult = await swapToken(
        connection,
        walletPublicKey as PublicKey,
        response.inputTokenCA as string,
        response.outputTokenCA as string,
        response.amount as number
      );

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
  examples: (spec.examples ?? []) as ActionExample[][],
};
