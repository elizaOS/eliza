// @ts-nocheck -- legacy wallet sync task from absorbed Birdeye plugin; strict types pending cleanup
import {
  type Content,
  createUniqueUuid,
  type IAgentRuntime,
  type ServiceTypeName,
  type UUID,
} from "@elizaos/core";
import { BIRDEYE_SERVICE_NAME } from "./constants";
import type { BirdeyeService } from "./service";
import type {
  BirdeyeSupportedChain,
  Portfolio,
  TransactionHistory,
} from "./types/shared";
import { extractChain } from "./utils";

export interface SentimentContent extends Content {
  text: string;
  source: "sentiment-analysis";
  metadata: {
    timeslot: string;
    processed: boolean;
    occuringTokens?: Array<{
      token: string;
      sentiment: number;
      reason: string;
    }>;
  };
}

export default class Birdeye {
  apiKey: string;
  sentimentRoomId: UUID;
  twitterFeedRoomId: UUID;
  runtime: IAgentRuntime;

  pSrvBirdeye: Promise<unknown>;
  beService!: BirdeyeService;

  constructor(runtime: IAgentRuntime) {
    this.apiKey = runtime.getSetting("BIRDEYE_API_KEY");
    this.sentimentRoomId = createUniqueUuid(runtime, "sentiment-analysis");
    this.twitterFeedRoomId = createUniqueUuid(runtime, "twitter-feed");
    this.runtime = runtime;

    this.pSrvBirdeye = runtime
      .getServiceLoadPromise(BIRDEYE_SERVICE_NAME as ServiceTypeName)
      .then(() => {
        this.beService = this.runtime.getService(
          BIRDEYE_SERVICE_NAME,
        ) as BirdeyeService;
      });
  }

  private async syncWalletHistory(
    chain: BirdeyeSupportedChain,
    publicKey: string,
  ) {
    try {
      await this.pSrvBirdeye;

      if (!this.beService) {
        throw new Error("BirdeyeService not initialized");
      }

      const birdeyeData = await this.beService.fetchWalletTxList(
        chain,
        publicKey,
      );

      const transactions: TransactionHistory[] = birdeyeData.map(
        (tx: { txHash: string; blockTime: number | string }) => ({
          txHash: tx.txHash,
          blockTime: new Date(tx.blockTime),
          data: tx,
        }),
      );

      try {
        const cachedTxs = await this.runtime.getCache<TransactionHistory[]>(
          "transaction_history",
        );
        if (cachedTxs && Array.isArray(cachedTxs)) {
          for (const cachedTx of cachedTxs) {
            if (!transactions.some((tx) => tx.txHash === cachedTx.txHash)) {
              transactions.push(cachedTx);
            }
          }
        }
      } catch (_error) {
        this.runtime.logger.debug(
          "Failed to get cached transactions, continuing with Birdeye data only",
        );
      }

      for (const tx of transactions) {
        if (typeof tx.blockTime === "string") {
          tx.blockTime = new Date(tx.blockTime);
        }
      }

      transactions.sort(
        (a, b) => b.blockTime.getTime() - a.blockTime.getTime(),
      );

      try {
        await this.runtime.setCache<TransactionHistory[]>(
          "transaction_history",
          transactions,
        );
        this.runtime.logger.debug(
          `Birdeye Task - Updated transaction history with ${transactions.length} transactions for ${publicKey}`,
        );
      } catch (error) {
        this.runtime.logger.debug(
          `Failed to set transaction cache, continuing without caching: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      return transactions;
    } catch (error) {
      this.runtime.logger.error(
        `Failed to sync wallet history from Birdeye: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }

  private async syncWalletPortfolio(
    chain: BirdeyeSupportedChain,
    publicKey: string,
  ) {
    await this.pSrvBirdeye;

    if (!this.beService) {
      throw new Error("BirdeyeService not initialized");
    }

    const data = await this.beService.fetchWalletTokenList(chain, publicKey);

    await this.runtime.setCache<Portfolio>("portfolio", {
      key: "PORTFOLIO",
      data,
    });
  }

  async syncWallet() {
    const walletAddr = this.runtime.getSetting("BIRDEYE_WALLET_ADDR");
    if (!walletAddr) {
      return;
    }

    const explicitChain = this.runtime.getSetting("BIRDEYE_CHAIN");

    try {
      const chain = extractChain(walletAddr, explicitChain);
      await this.syncWalletHistory(chain, walletAddr);
      await this.syncWalletPortfolio(chain, walletAddr);

      return true;
    } catch (error) {
      this.runtime.logger?.error(
        `Failed to sync wallet: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }
}
