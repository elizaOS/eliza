import {
  type IAgentRuntime,
  logger,
  Service,
  ServiceType,
} from "@elizaos/core";
import assert from "node:assert";
import { LEVVA_SERVICE } from "../constants/enum.ts";
import { ILevvaService } from "../types/service.ts";
import { BrowserService } from "./browser.ts";
import { blockexplorers, getChain, getToken } from "../util";
import { CacheEntry } from "src/types/core.ts";
import { CalldataWithDescription } from "src/types/tx.ts";
import { sha256, toHex } from "viem";
import {
  getActiveMarkets,
  PendleActiveMarkets,
} from "src/api/market/pendle.ts";

const REQUIRED_PLUGINS = ["levva"];

function checkPlugins(runtime: IAgentRuntime) {
  const set = new Set(runtime.plugins.map((plugin) => plugin.name));
  return REQUIRED_PLUGINS.every((plugin) => set.has(plugin));
}

export class LevvaService extends Service implements ILevvaService {
  static serviceType = LEVVA_SERVICE.LEVVA_COMMON;
  capabilityDescription =
    "Levva service should analyze the user's portfolio, suggest earning strategies, swap crypto assets, etc.";

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    assert(checkPlugins(runtime), "Required plugins not found");
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

    const portfolio = await browser.processPageContent(url, async (html) => {
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
    });

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
  // todo fetch from cryptopanic rss feed
  async getCryptoNews() {
    const browser = await this.runtime.getService<BrowserService>(
      ServiceType.BROWSER
    );

    const url = "https://cryptopanic.com/news/rss/";
    const cacheKey = `feed:crypto-panic`;
    // timed cache, todo make util function
    const cacheTime = 1800000;
    const timestamp = Date.now();

    const cached = await this.runtime.getCache<CacheEntry<{}[]>>(cacheKey);

    if (cached?.timestamp && timestamp - cached.timestamp < cacheTime) {
      return cached.value;
    }

    const feed = await browser.processPageContent(
      url,
      async (text) => {
        console.log(text);
        return `<task>Please generate a summary for every entry in the news feed in given text</task>
<text>
${text}
</text>
<keys>
- topics - array of objects with the following keys:
  - "title" - title of the news entry
  - "summary" - summary of the news entry
  - "source" - url of the news source
</keys>
<output>
Respond using JSON format like this:
{
  "topics": <array>
}
Your response should include the valid JSON block and nothing else.
</output>
`;
      },
      "text"
    );

    // todo type check
    await this.runtime.setCache(cacheKey, {
      timestamp,
      value: feed?.topics ?? [],
    });

    return feed?.topics ?? [];
  }
  // -- End of Crypto news --

  async getPendleMarkets(params: { chainId: number }) {
    const ttl = 3600000;
    const cacheKey = `pendle:markets:${params.chainId}`;
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
