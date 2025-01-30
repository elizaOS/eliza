import { z } from "zod";
import { elizaLogger } from "@elizaos/core";
import { MAX_TWEETS_PER_HOUR } from "../constants";
import type { MarketData } from "../types";

export const TwitterConfigSchema = z.object({
  enabled: z.boolean(),
  username: z.string().min(1),
  dryRun: z.boolean().optional().default(false),
  apiKey: z.string().optional(),
});

export interface TradeAlert {
  token: string;
  amount: number;
  trustScore: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  marketData: {
    priceChange24h: number;
    volume24h: number;
    liquidity: {
      usd: number;
    };
  };
  timestamp: number;
  signature?: string;
  action?: "BUY" | "SELL" | "WAIT" | "SKIP";
  reason?: string;
  price?: number;
  profitPercent?: string;
  profitUsd?: string;
}

export interface TradeBuyAlert {
  token: string;
  tokenAddress: string;
  amount: number;
  trustScore: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  marketData: MarketData;
  timestamp: number;
  signature?: string;
  hash?: string;
  explorerUrl?: string;
  action?: "BUY" | "SELL" | "WAIT" | "SKIP";
  reason?: string;
  price?: number;
  profitPercent?: string;
  profitUsd?: string;
}

// Set up trade notification function
export const tweetTrade = async (
  twitterService: TwitterService,
  alert: TradeBuyAlert,
) => {
  if (twitterService) {
    await twitterService.postTradeAlert({
      ...alert,
      timestamp: Date.now(),
    });
  }
};

export function canTweet(tweetType: "trade" | "market_search" | "shabbat" | "holiday"): boolean {
  const now = Date.now();
  const hourKey = `tweets_${tweetType}_${Math.floor(now / 3600000)}`;

  // Simple in-memory rate limiting
  const tweetCounts = new Map<string, number>();
  const currentCount = tweetCounts.get(hourKey) || 0;

  if (currentCount >= MAX_TWEETS_PER_HOUR[tweetType]) {
    elizaLogger.warn(`Tweet rate limit reached for ${tweetType}`);
    return false;
  }

  tweetCounts.set(hourKey, currentCount + 1);
  return true;
}

/*
interface TweetOptions {
  skipRateLimit?: boolean;
  type?: 'trade' | 'market_search' | 'shabbat' | 'holiday';
}
*/

export class TwitterService {
  private client: any;
  private config: z.infer<typeof TwitterConfigSchema>;

  // Add public getter for config
  public getConfig() {
    return this.config;
  }

  constructor(client: any, config: z.infer<typeof TwitterConfigSchema>) {
    this.client = client;
    this.config = config;
  }

  async postTradeAlert(alert: TradeBuyAlert): Promise<boolean> {
    try {
      const tweetContent = this.formatBuyAlert(alert);

      if (this.config.dryRun) {
        elizaLogger.log(
          "Dry run mode - would have posted tweet:",
          tweetContent,
        );
        return true;
      }

      if (!canTweet("trade")) {
        elizaLogger.warn("Trade tweet rate limit reached");
        return false;
      }

      // Use the correct client structure
      await this.client.post.client.twitterClient.sendTweet(tweetContent);
      elizaLogger.log("Successfully posted trade alert to Twitter:", {
        content: tweetContent,
      });

      return true;
    } catch (error) {
      elizaLogger.error("Failed to post trade alert to Twitter:", {
        error: error instanceof Error ? error.message : String(error),
        alert,
      });
      return false;
    }
  }

  private formatBuyAlert(alert: TradeBuyAlert): string {
    const priceChangePrefix = alert.marketData.priceChange24h >= 0 ? "+" : "";
    const trustScoreEmoji =
      alert.trustScore >= 0.8 ? "🟢" : alert.trustScore >= 0.5 ? "🟡" : "🔴";


    // Don't include explorer URL if we don't have a valid signature/hash
    const hasValidTxId = alert.hash || alert.signature;
    const explorerUrl = hasValidTxId
        ? `https://solscan.io/tx/${alert.signature}`
      : null;

    if (alert.action === "SELL") {
      // Simplified SELL format
      const actionEmoji =
        Number(alert.profitPercent?.replace("%", "")) >= 0
          ? "💰 PROFIT SELL"
          : "🔴 LOSS SELL";

      const lines = [
        `${actionEmoji} | ${alert.token}`,
        `📊 P/L: ${alert.profitPercent}`,
        `⚠️ Risk: ${alert.riskLevel}`,
        `💲 Price: $${alert.price?.toFixed(6)}`,
        `📈 24h: ${priceChangePrefix}${alert.marketData.priceChange24h.toFixed(1)}%`,
        explorerUrl ? `🔍 ${explorerUrl}` : null,
        `$${alert.token}`,
      ];

      return lines.filter(Boolean).join("\n");
    } else {
      // Simplified BUY format
      const lines = [
        `🟢 BUY | ${alert.token}`,
        `🎯 Trust: ${trustScoreEmoji} ${(alert.trustScore * 100).toFixed(0)}%`,
        `📈 24h: ${priceChangePrefix}${alert.marketData.priceChange24h.toFixed(1)}%`,
        `⚠️ Risk: ${alert.riskLevel}`,
        `💲 Price: $${alert.price?.toFixed(6)}`,
        explorerUrl ? `🔍 ${explorerUrl}` : null,
        `$${alert.token}`,
      ];

      return lines.filter(Boolean).join("\n");
    }
  }
}