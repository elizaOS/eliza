import { and, eq, gte, InferSelectModel } from "drizzle-orm";
import { getAddress } from "viem";
import { type IAgentRuntime, ServiceType } from "@elizaos/core";
import { PROXIES } from "./constants";
import { BrowserService } from "../browser";
import { balancesTable } from "../../schema/balances";
import type { CacheEntry } from "../../types/core";
import { blockexplorers, getDb, TokenEntry } from "../../util";
import { ETH_NULL_ADDR } from "src/constants/eth";

export type BalanceEntry = InferSelectModel<typeof balancesTable>;

interface GetBalanceParams {
  chainId: number;
  address: `0x${string}`;
  ttl?: number;
}

export const getBalance = async (
  runtime: IAgentRuntime,
  params: GetBalanceParams
) => {
  const db = getDb(runtime);

  return db
    .select()
    .from(balancesTable)
    .where(
      params.ttl
        ? and(
            gte(balancesTable.updatedAt, new Date(Date.now() - params.ttl)),
            eq(balancesTable.address, getAddress(params.address))
          )
        : eq(balancesTable.address, getAddress(params.address))
    );
};

interface UpsertBalanceParams {
  chainId: number;
  address: `0x${string}`;
  token: `0x${string}`;
  amount: bigint;
  value: bigint;
}

export const upsertBalance = async (
  runtime: IAgentRuntime,
  params: UpsertBalanceParams
) => {
  const db = getDb(runtime);
  const now = new Date();
  const { address, token, ...rest } = params;

  return (
    await db
      .insert(balancesTable)
      .values({
        ...rest,
        address: getAddress(address),
        type: token && token !== ETH_NULL_ADDR ? "erc20" : "native",
        token: token ? getAddress(token) : ETH_NULL_ADDR,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          balancesTable.chainId,
          balancesTable.address,
          balancesTable.token,
        ],
        set: {
          ...rest,
          updatedAt: now,
        },
      })
      .returning()
  )?.[0];
};

export interface AssetEntry {
  address?: `0x${string}`;
  symbol: string;
  balance: string;
  value: string;
}

/** @deprecated fetching in browser needs new proxies constantly */
export async function fetchAssetsFromExplorer(
  runtime: IAgentRuntime,
  address: `0x${string}`,
  chainId: number
) {
  const browser = await runtime.getService<BrowserService>(ServiceType.BROWSER);
  const explorer = blockexplorers.get(chainId);

  if (!browser) {
    throw new Error("Browser service not found");
  }

  if (!explorer) {
    throw new Error(
      `Unsupported chain ${chainId}, reason = block explorer not found`
    );
  }

  const url = `${explorer}/address/${address}`;
  const cacheKey = `portfolio:${address}:${chainId}`;
  // timed cache, todo make util function
  const cacheTime = 3600000;
  const timestamp = Date.now();

  // todo replace cache with balances table
  const cached = await runtime.getCache<CacheEntry<AssetEntry[]>>(cacheKey);

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
  const assets: AssetEntry[] = portfolio?.assets ?? [];

  await runtime.setCache(cacheKey, {
    timestamp,
    value: assets,
  });

  return assets;
}

export interface WalletInterface {
  getAvailableTokens: (params: {
    chainId: number;
  }) => Promise<Omit<TokenEntry, "id">[]>;

  formatToken: (token: Omit<TokenEntry, "id">) => string;

  getWalletAssets: (params: {
    address: `0x${string}`;
    chainId: number;
  }) => Promise<Omit<BalanceEntry, "id">[]>;

  formatWalletAssets(assets: Omit<BalanceEntry, "id">[]): string;
}
