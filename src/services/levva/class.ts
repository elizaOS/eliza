import assert from "node:assert";
import EventEmitter from "node:events";
import { sha256, toHex } from "viem";
import {
  type IAgentRuntime,
  logger,
  Service,
  ServiceType,
} from "@elizaos/core";
import { BrowserService, PageContent } from "../browser.ts";
import { LEVVA_SERVICE } from "../../constants/enum.ts";
import {
  getActiveMarkets,
  PendleActiveMarkets,
} from "../../api/market/pendle.ts";
import { CacheEntry } from "../../types/core.ts";
import { ILevvaService } from "../../types/service.ts";
import { CalldataWithDescription } from "../../types/tx.ts";
import { blockexplorers, getChain, getToken } from "../../util/index.ts";
import { xmlParser } from "../../util/xml.ts";
import { delay, isRejected, isResolved } from "../../util/async.ts";
import { getFeed, getFeedItemId, getLatestNews, isFeedItem, onFeedItem } from "./news.ts";

const REQUIRED_PLUGINS = ["levva"];

// todo config
const PROXIES = [
  { ip: "46.8.5.131", port: "8000", username: "FCCWKQ", password: "a7CxRa" },
  { ip: "45.83.9.114", port: "8000", username: "FCCWKQ", password: "a7CxRa" },
];

function checkPlugins(runtime: IAgentRuntime) {
  const set = new Set(runtime.plugins.map((plugin) => plugin.name));
  return REQUIRED_PLUGINS.every((plugin) => set.has(plugin));
}

const MAX_WAIT_TIME = 15000;

export class LevvaService extends Service implements ILevvaService {
  static serviceType = LEVVA_SERVICE.LEVVA_COMMON;
  capabilityDescription =
    "Levva service should analyze the user's portfolio, suggest earning strategies, swap crypto assets, etc.";

  private events = new EventEmitter();
  private background: { id?: string; promise: Promise<unknown> }[] = [];

  private handlerInterval: NodeJS.Timeout | null = null;

  private bgHandler = async () => {
    const unresolved: { id?: string; promise: Promise<unknown> }[] = [];

    for (const { id, promise } of this.background) {
      if (await isResolved(promise)) {
        if (id) {
          this.events.emit("background:resolved", { id, value: await promise });
        }
      } else if (await isRejected(promise)) {
        try {
          await promise;
        } catch (error) {
          logger.error(`Background promise rejected: ${id}`, error);
        }
      } else {
        unresolved.push({ id, promise });
      }
    }

    this.background = unresolved;
  };

  private inBackground = async <T>(
    fn: () => Promise<T>,
    id?: string
  ): Promise<T | undefined> => {
    const promise = fn();
    this.background.push({ id, promise });
    return Promise.race([promise, delay(MAX_WAIT_TIME, undefined)]);
  };

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    assert(checkPlugins(runtime), "Required plugins not found");
    this.handlerInterval = setInterval(this.bgHandler, 500);

    this.events.on("background:resolved", (event) => {
      // logger.info(`Background promise resolved: ${event.id}`, event.value);

      if (isFeedItem(event.id)) {
        onFeedItem(this.runtime, event.id, event.value);
      }
    });
  }

  static async start(runtime: IAgentRuntime) {
    logger.info("*** Starting Levva service ***");
    const service = new LevvaService(runtime);
    return service;
  }

  static async stop(runtime: IAgentRuntime) {
    logger.info("*** Stopping Levva service ***");
    // get the service from the runtime
    const service = runtime.getService(LevvaService.serviceType);

    if (!service) {
      throw new Error("Levva service not found");
    }

    service.stop();
  }

  async stop() {
    logger.info("*** Stopping levva service instance ***");

    if (this.handlerInterval) {
      clearInterval(this.handlerInterval);
      this.handlerInterval = null;
    }
  }

  async getAvailableTokens(params: { chainId: number }) {
    const chain = getChain(params.chainId);
    const tokens = await getToken(this.runtime, { chainId: params.chainId });

    tokens.push({
      symbol: chain.nativeCurrency.symbol,
      name: chain.nativeCurrency.name,
      decimals: chain.nativeCurrency.decimals,
      address: undefined,
      info: undefined,
      chainId: params.chainId,
    });

    return tokens;
  }

  formatToken(token: {
    symbol: string;
    name: string;
    address?: string;
    decimals: number;
    info?: Record<string, any>;
  }) {
    return `${token.symbol}(${token.name}) - ${token.address ? `Deployed as ${token.address}` : "Native token"}. Decimals: ${token.decimals}.${token.info ? ` Additional Info: ${JSON.stringify(token.info)}` : ""}`;
  }

  // -- Wallet assets --
  // todo implement other balance sources, now simulating browser visit to blockexplorer
  async getWalletAssets(params: { address: `0x${string}`; chainId: number }) {
    const browser = await this.runtime.getService<BrowserService>(
      ServiceType.BROWSER
    );

    const explorer = blockexplorers.get(params.chainId);

    if (!explorer) {
      throw new Error(
        `Unsupported chain ${params.chainId}, reason = block explorer not found`
      );
    }

    const url = `${explorer}/address/${params.address}`;
    const cacheKey = `portfolio:${params.address}:${params.chainId}`;
    // timed cache, todo make util function
    const cacheTime = 3600000;
    const timestamp = Date.now();

    const cached =
      await this.runtime.getCache<
        CacheEntry<
          { symbol: string; balance: string; value: string; address?: string }[]
        >
      >(cacheKey);

    if (cached?.timestamp && timestamp - cached.timestamp < cacheTime) {
      return cached.value;
    }

    const portfolio = await browser.processPageContent(
      url,
      async (html) => {
        const begin = html.indexOf("<!-- Content");
        const end = html.indexOf("<!-- End Content");
        return `<task>analyze given html and extract the wallet assets</task>
        <html>
          ${html.slice(begin, end)}
        </html>
        <instructions>
          - Find the DIV block titled "ETH Balance" and extract the balance.
          - Find the DIV block titled "Token Holdings" and extract the balances and addresses of tokens in dropdown.
        </instructions>
        <keys>
          - "assets" should be an array of objects with the following keys:
            - "symbol"
            - "balance"
            - "value"
            - "address" (optional for native token)
        </keys>
        <output>
          Respond using JSON format like this:
          {
            "assets": [
              {
                "symbol": "ETH",
                "balance": "0.03400134",
                "value": "80.2"
              },
              {
                "symbol": "USDT",
                "balance: "20.1234",
                "value": "20.111223344",
                "address": "0xdac17f958d2ee523a2206206994597c13d831ec7",
              }
            ]
          }
        </output>
        `;
      },
      "html",
      PROXIES
    );

    // todo type check
    const assets: {
      symbol: string;
      balance: string;
      value: string;
      address?: string;
    }[] = portfolio?.assets ?? [];

    await this.runtime.setCache(cacheKey, {
      timestamp,
      value: assets,
    });

    return assets;
  }

  formatWalletAssets(
    assets: {
      symbol: string;
      balance: string;
      value: string;
      address?: string;
    }[]
  ): string {
    return assets
      .map(
        (asset) =>
          `${asset.symbol} - ${asset.address ? `Token deployed as ${asset.address}` : "Native token"}. Balance: ${asset.balance}. Value: ${asset.value} USD.`
      )
      .join("\n");
  }

  // -- End of Wallet Assets --
  // -- Crypto news --

  // todo config
  private RSS_FEEDS = ["https://cryptopanic.com/news/rss/"];

  private fetchFeed = async (url: string) => {
    const browser = await this.runtime.getService<BrowserService>(
      ServiceType.BROWSER
    );

    try {
      logger.info(`Fetching feed: ${url}`);
      const items = await getFeed(this.runtime, url);

      await Promise.all(
        items.map((item, i) => {
          const id = getFeedItemId(item.link);

          return this.inBackground(
            async () =>
              browser.getPageContent(item.link, this.runtime, i * 1000),
            id
          );
        })
      );
    } catch (error) {
      console.error(error);
      logger.info(error.stack);
    }
  };

  async getCryptoNews(limit?: number) {
    await Promise.allSettled(this.RSS_FEEDS.map(this.fetchFeed));
    return getLatestNews(this.runtime, limit);
  }
  // -- End of Crypto news --

  async getPendleMarkets(params: { chainId: number }) {
    const ttl = 3600000;
    const cacheKey = `pendle-markets:${params.chainId}`;
    const cached =
      await this.runtime.getCache<CacheEntry<PendleActiveMarkets>>(cacheKey);

    if (cached?.timestamp && Date.now() - cached.timestamp < ttl) {
      return cached.value;
    }

    const markets = await getActiveMarkets(params.chainId);

    if (!markets.success) {
      console.error("Failed to get pendle markets", markets.error);
      throw new Error("Failed to get pendle markets");
    }

    const value = markets.data.markets;

    await this.runtime.setCache(cacheKey, {
      timestamp: Date.now(),
      value,
    });

    return value;
  }

  async createCalldata(
    calls: CalldataWithDescription[]
  ): Promise<`0x${string}`> {
    const hash = await sha256(toHex(JSON.stringify(calls)));

    if (!(await this.runtime.setCache(`calldata:${hash}`, calls))) {
      throw new Error("Failed to save calldata in cache");
    }

    return hash;
  }

  async getCalldata(hash: `0x${string}`): Promise<CalldataWithDescription[]> {
    const cached = await this.runtime.getCache<CalldataWithDescription[]>(
      `calldata:${hash}`
    );

    if (!cached) {
      throw new Error("Calldata not found in cache");
    }

    return cached;
  }
}
