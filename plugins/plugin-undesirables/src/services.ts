import { type IAgentRuntime, logger, Service } from "@elizaos/core";

const IMGFLIP_MEMES_URL = "https://api.imgflip.com/get_memes";
const TREND_REFRESH_MS = 6 * 60 * 60 * 1000;

export type MemeTrend = {
  name: string;
  url?: string;
  width?: number;
  height?: number;
  boxCount?: number;
};

const FALLBACK_TRENDS: MemeTrend[] = [
  { name: "Distracted Boyfriend", boxCount: 3 },
  { name: "Drake Hotline Bling", boxCount: 2 },
  { name: "Two Buttons", boxCount: 3 },
  { name: "Change My Mind", boxCount: 2 },
  { name: "Expanding Brain", boxCount: 4 },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseMemeTrend(value: unknown): MemeTrend | null {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim()) {
    return null;
  }

  return {
    name: value.name.trim(),
    url: typeof value.url === "string" && value.url ? value.url : undefined,
    width: typeof value.width === "number" && Number.isFinite(value.width) ? value.width : undefined,
    height:
      typeof value.height === "number" && Number.isFinite(value.height) ? value.height : undefined,
    boxCount:
      typeof value.box_count === "number" && Number.isFinite(value.box_count)
        ? value.box_count
        : undefined,
  };
}

function parseImgflipResponse(payload: unknown): MemeTrend[] {
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.data)) {
    return [];
  }

  const memes = Array.isArray(payload.data.memes) ? payload.data.memes : [];
  const trends: MemeTrend[] = [];
  const seen = new Set<string>();
  for (const meme of memes) {
    const trend = parseMemeTrend(meme);
    if (!trend) continue;
    const key = trend.name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    trends.push(trend);
  }
  return trends;
}

export class MemeTrendService extends Service {
  static serviceType = "MEME_TREND_MONITOR";

  private monitorInterval: NodeJS.Timeout | null = null;
  private trends: MemeTrend[] = FALLBACK_TRENDS;
  private lastUpdatedAt: Date | null = null;

  get capabilityDescription(): string {
    return "Monitors meme trends and content patterns for The Undesirables";
  }

  static async start(runtime: IAgentRuntime): Promise<MemeTrendService> {
    const service = new MemeTrendService();
    await service.initialize(runtime);
    return service;
  }

  async initialize(_runtime: IAgentRuntime): Promise<void> {
    await this.pollTrends();
    this.monitorInterval = setInterval(() => {
      void this.pollTrends();
    }, TREND_REFRESH_MS);
    this.monitorInterval.unref?.();
  }

  async stop(): Promise<void> {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }

  getTrends(limit = 5): MemeTrend[] {
    return this.trends.slice(0, Math.max(0, limit));
  }

  getTrendContext(limit = 5): string {
    const trends = this.getTrends(limit);
    const source = this.lastUpdatedAt ? `Imgflip templates refreshed ${this.lastUpdatedAt.toISOString()}` : "fallback templates";
    return [
      `Current meme template signals (${source}):`,
      ...trends.map((trend, index) => {
        const slots = trend.boxCount ? `, ${trend.boxCount} text slots` : "";
        return `${index + 1}. ${trend.name}${slots}`;
      }),
    ].join("\n");
  }

  async pollTrends(): Promise<void> {
    try {
      const response = await fetch(IMGFLIP_MEMES_URL, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      if (!response.ok) {
        logger.warn(
          { src: "plugin-undesirables", status: response.status },
          "Meme trend refresh failed"
        );
        return;
      }

      const trends = parseImgflipResponse(await response.json());
      if (trends.length === 0) {
        logger.warn({ src: "plugin-undesirables" }, "Meme trend refresh returned no templates");
        return;
      }

      this.trends = trends;
      this.lastUpdatedAt = new Date();
    } catch (err) {
      logger.warn({ src: "plugin-undesirables", err }, "Meme trend refresh failed");
    }
  }
}
