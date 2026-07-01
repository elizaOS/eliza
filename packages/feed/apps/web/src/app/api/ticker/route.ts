/**
 * Ticker Data API
 *
 * @route GET /api/ticker - Get normalized ticker data for news, predictions, perps
 * @access Public
 *
 * Returns a unified JSON payload with optional streams. Used by the ticker embed page
 * and external embedders. Only requested streams are included.
 *
 * @query streams - Comma-separated: news, predictions, perps (default: all)
 * @query limit - Max items per stream (default: 20)
 */

import {
  addPublicReadHeaders,
  publicRateLimit,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import {
  PredictionDbAdapter,
  PredictionMarketService,
  PredictionPricing,
} from "@feed/core/markets/prediction";
import { FEE_CONFIG, WalletService } from "@feed/engine";
import { logger } from "@feed/shared";
import type { NextRequest } from "next/server";
import type {
  TickerNewsItem,
  TickerPerpItem,
  TickerPredictionItem,
  TickerResponse,
} from "@/types/ticker";
import { createPerpMarketService } from "../markets/perps/_adapters";

const DEFAULT_STREAMS = ["news", "predictions", "perps"] as const;
const DEFAULT_LIMIT = 20;
const VALID_STREAMS = new Set<string>(DEFAULT_STREAMS);

function parseStreams(value: string | null): Set<string> {
  if (!value?.trim()) {
    return new Set(DEFAULT_STREAMS);
  }
  const requested = value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => VALID_STREAMS.has(s));
  return new Set(requested.length > 0 ? requested : DEFAULT_STREAMS);
}

function parseLimit(value: string | null): number {
  if (!value?.trim()) return DEFAULT_LIMIT;
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, 100);
}

export const dynamic = "force-dynamic";
export const revalidate = 60;

export const GET = withErrorHandling(async (request: NextRequest) => {
  const { error, rateLimitInfo } = await publicRateLimit(request);
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const streams = parseStreams(searchParams.get("streams"));
  const limit = parseLimit(searchParams.get("limit"));

  const result: TickerResponse = {};

  const origin =
    request.headers.get("x-forwarded-host") &&
    request.headers.get("x-forwarded-proto")
      ? `${request.headers.get("x-forwarded-proto")}://${request.headers.get("x-forwarded-host")}`
      : process.env.NEXT_PUBLIC_BASE_URL ||
        (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
        new URL(request.url).origin;

  if (streams.has("news")) {
    try {
      const breakingNewsUrl = `${origin}/api/feed/widgets/breaking-news?limit=${limit}`;
      const res = await fetch(breakingNewsUrl, { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as {
          success?: boolean;
          news?: Array<{
            id: string;
            title: string;
            description?: string;
            timestamp: string;
          }>;
        };
        let news = data.news ?? [];
        if (news.length === 0) {
          const postsUrl = `${origin}/api/posts?type=article&limit=${limit}`;
          const postsRes = await fetch(postsUrl, { cache: "no-store" });
          if (postsRes.ok) {
            const postsData = (await postsRes.json()) as {
              posts?: Array<{
                id: string;
                articleTitle?: string;
                content?: string;
                timestamp?: string;
              }>;
            };
            const posts = postsData.posts ?? [];
            news = posts.slice(0, limit).map((p) => {
              const ts = p.timestamp;
              const timestamp =
                typeof ts === "string"
                  ? ts
                  : ts != null &&
                      typeof (ts as { toISOString?: () => string })
                        .toISOString === "function"
                    ? (ts as { toISOString: () => string }).toISOString()
                    : new Date().toISOString();
              return {
                id: p.id,
                title: p.articleTitle ?? p.content?.slice(0, 80) ?? "Article",
                description: "",
                timestamp,
              };
            });
          }
        }
        result.news = news.slice(0, limit).map(
          (item): TickerNewsItem => ({
            id: item.id,
            title: item.title,
            summary: item.description ?? "",
            timestamp: item.timestamp,
            type: "news",
          }),
        );
        logger.info(
          "Ticker news",
          {
            origin,
            breakingNewsStatus: res.status,
            breakingNewsCount: (data.news ?? []).length,
            usedPostsFallback: (data.news ?? []).length === 0,
            finalNewsCount: result.news?.length ?? 0,
          },
          "GET /api/ticker",
        );
      } else {
        result.news = [];
        logger.warn(
          "Ticker breaking-news not ok",
          { origin, status: res.status, url: breakingNewsUrl },
          "GET /api/ticker",
        );
      }
    } catch (e) {
      logger.warn("Ticker news fetch failed", { error: e }, "GET /api/ticker");
      result.news = [];
    }
  }

  if (streams.has("predictions")) {
    try {
      const dbAdapter = new PredictionDbAdapter();
      const service = new PredictionMarketService({
        db: dbAdapter,
        wallet: {
          debit: ({ userId, amount, reason, description, relatedId }) =>
            WalletService.debit(
              userId,
              amount,
              reason,
              description ?? "",
              relatedId,
            ),
          credit: ({ userId, amount, reason, description, relatedId }) =>
            WalletService.credit(
              userId,
              amount,
              reason,
              description ?? "",
              relatedId,
            ),
          recordPnL: async ({ userId, pnl, reason, relatedId }) => {
            await WalletService.recordPnL(userId, pnl, reason, relatedId);
          },
          getBalance: (uid: string) => WalletService.getBalance(uid),
        },
        fees: {
          tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
          platformShare: FEE_CONFIG.PLATFORM_SHARE,
          referrerShare: FEE_CONFIG.REFERRER_SHARE,
          minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
        },
      });
      const markets = await service.listMarkets();
      const yesPercent = (m: { yesShares: number; noShares: number }) =>
        Math.round(
          PredictionPricing.getCurrentPrice(m.yesShares, m.noShares, "yes") *
            100,
        );
      result.predictions = markets.slice(0, limit).map(
        (m): TickerPredictionItem => ({
          id: m.id,
          question: m.question,
          yesPercent: yesPercent(m),
          status: m.status ?? (m.resolved ? "resolved" : "active"),
          type: "prediction",
        }),
      );
    } catch (e) {
      logger.warn(
        "Ticker predictions fetch failed",
        { error: e },
        "GET /api/ticker",
      );
      result.predictions = [];
    }
  }

  if (streams.has("perps")) {
    try {
      const service = createPerpMarketService();
      const markets = await service.getMarketsSnapshot();
      result.perps = markets.slice(0, limit).map((m): TickerPerpItem => {
        const storedChange = m.changePercent24h;
        const hasReference =
          m.price24hAgo != null &&
          m.price24hAgo !== 0 &&
          m.price24hAgo !== m.currentPrice;
        const changePercent24h: number | null =
          storedChange !== 0
            ? storedChange
            : hasReference
              ? ((m.currentPrice - m.price24hAgo!) / m.price24hAgo!) * 100
              : null;
        return {
          ticker: m.ticker,
          price: m.currentPrice,
          changePercent24h,
          type: "perp",
        };
      });
    } catch (e) {
      logger.warn("Ticker perps fetch failed", { error: e }, "GET /api/ticker");
      result.perps = [];
    }
  }

  logger.info(
    "Ticker data served",
    {
      streams: Array.from(streams),
      counts: {
        news: result.news?.length ?? 0,
        predictions: result.predictions?.length ?? 0,
        perps: result.perps?.length ?? 0,
      },
    },
    "GET /api/ticker",
  );

  const response = successResponse(result);
  if (rateLimitInfo) addPublicReadHeaders(response, rateLimitInfo);
  return response;
});
