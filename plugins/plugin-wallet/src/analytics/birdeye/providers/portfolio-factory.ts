// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { BIRDEYE_SERVICE_NAME } from "../constants";
import type { WalletPortfolioResponse } from "../types/api/wallet";
import { extractChain, formatJsonScalar, formatJsonTable } from "../utils";

type PortfolioService = {
  fetchWalletTokenList?: (
    chain: unknown,
    walletAddr: string,
    opts: { notOlderThan: number },
  ) => Promise<unknown>;
  fetchWalletTxList?: (
    chain: unknown,
    walletAddr: string,
    opts: { notOlderThan: number },
  ) => Promise<unknown[]>;
};

export interface BirdeyePortfolioProviderOptions {
  name: string;
  description: string;
  descriptionCompressed: string;
  includeTrades?: boolean;
}

function statusJson(name: string, status: string, reason: string): string {
  return [
    `${name}:`,
    `  status: ${formatJsonScalar(status)}`,
    `  reason: ${formatJsonScalar(reason)}`,
  ].join("\n");
}

function normalizePortfolioResponse(response: unknown) {
  if (response?.data?.items) {
    return response.data;
  }
  return response ?? {};
}

export const formatPortfolio = (response: WalletPortfolioResponse) => {
  const portfolio = normalizePortfolioResponse(response);
  const items = portfolio.items ?? [];
  if (!items.length) return "holdings[0]: []";

  return formatJsonTable(
    "holdings",
    items.map((item) => ({
      symbol: item.symbol || "unknown",
      address: item.address || "unknown",
      amount:
        typeof item.uiAmount === "number"
          ? Number(item.uiAmount.toFixed(4))
          : "unknown",
      priceUsd:
        typeof item.priceUsd === "number"
          ? Number(item.priceUsd.toFixed(6))
          : "unknown",
      valueUsd:
        typeof item.valueUsd === "number"
          ? Number(item.valueUsd.toFixed(2))
          : "unknown",
      chainId: item.chainId || "unknown",
    })),
    ["symbol", "address", "amount", "priceUsd", "valueUsd", "chainId"],
  );
};

function formatPortfolioProviderText({
  wallet,
  chain,
  portfolio,
  trades,
}: {
  wallet: string;
  chain: string;
  portfolio: unknown;
  trades?: unknown[];
}): string {
  const normalized = normalizePortfolioResponse(portfolio);
  const holdings = normalized.items ?? [];
  const lines = [
    "birdeye_wallet_portfolio:",
    "  status: ok",
    `  wallet: ${formatJsonScalar(normalized.wallet ?? wallet)}`,
    `  chain: ${formatJsonScalar(chain)}`,
    `  totalUsd: ${formatJsonScalar(normalized.totalUsd ?? 0)}`,
    formatJsonTable(
      "  holdings",
      holdings.slice(0, 20).map((item) => ({
        symbol: item.symbol || "unknown",
        address: item.address || "unknown",
        amount:
          typeof item.uiAmount === "number"
            ? Number(item.uiAmount.toFixed(4))
            : "unknown",
        priceUsd:
          typeof item.priceUsd === "number"
            ? Number(item.priceUsd.toFixed(6))
            : "unknown",
        valueUsd:
          typeof item.valueUsd === "number"
            ? Number(item.valueUsd.toFixed(2))
            : "unknown",
        chainId: item.chainId || "unknown",
      })),
      ["symbol", "address", "amount", "priceUsd", "valueUsd", "chainId"],
    ),
  ];

  if (trades) {
    lines.push(`  tradeCount: ${trades.length}`);
    lines.push(
      formatJsonTable(
        "  trades",
        trades.slice(0, 10).map((trade) => ({
          txHash: trade.txHash ?? "unknown",
          action: trade.mainAction ?? "unknown",
          status: trade.status ?? "unknown",
          blockTime: trade.blockTime ?? "unknown",
          from: trade.from ?? "unknown",
          to: trade.to ?? "unknown",
        })),
        ["txHash", "action", "status", "blockTime", "from", "to"],
      ),
    );
  }

  return lines.join("\n");
}

function getPortfolioService(
  runtime: IAgentRuntime,
  includeTrades: boolean,
): PortfolioService | undefined {
  const beService = runtime.getService(BIRDEYE_SERVICE_NAME) as
    | PortfolioService
    | undefined;
  if (!beService || typeof beService.fetchWalletTokenList !== "function") {
    return undefined;
  }
  if (includeTrades && typeof beService.fetchWalletTxList !== "function") {
    return undefined;
  }
  return beService;
}

export function createBirdeyePortfolioProvider(
  options: BirdeyePortfolioProviderOptions,
): Provider {
  const includeTrades = options.includeTrades ?? false;
  return {
    name: options.name,
    description: options.description,
    descriptionCompressed: options.descriptionCompressed,
    dynamic: true,
    contexts: ["finance", "crypto", "wallet"],
    contextGate: { anyOf: ["finance", "crypto", "wallet"] },
    cacheStable: false,
    cacheScope: "turn",
    roleGate: { minRole: "OWNER" },
    get: async (runtime: IAgentRuntime, _message: Memory, _state?: State) => {
      try {
        const walletAddr = runtime.getSetting("BIRDEYE_WALLET_ADDR");
        if (!walletAddr) {
          runtime.logger?.error(
            "BIRDEYE_WALLET_ADDR setting is not configured",
          );
          return {
            values: {},
            text: statusJson(
              "birdeye_wallet_portfolio",
              "error",
              "missing BIRDEYE_WALLET_ADDR",
            ),
            data: {},
          };
        }

        const explicitChain = runtime.getSetting("BIRDEYE_CHAIN");
        const chain = extractChain(walletAddr, explicitChain);
        const beService = getPortfolioService(runtime, includeTrades);
        if (!beService) {
          runtime.logger?.error(
            "Birdeye service is unavailable or missing required portfolio methods",
          );
          return {
            values: {},
            text: statusJson(
              "birdeye_wallet_portfolio",
              "unavailable",
              includeTrades
                ? "missing fetchWalletTokenList or fetchWalletTxList"
                : "missing fetchWalletTokenList",
            ),
            data: {},
          };
        }

        const portfolioPromise = beService.fetchWalletTokenList(
          chain,
          walletAddr,
          { notOlderThan: 30 * 1000 },
        );
        const tradesPromise = includeTrades
          ? beService.fetchWalletTxList(chain, walletAddr, {
              notOlderThan: 30 * 1000,
            })
          : Promise.resolve(undefined);
        const [portfolio, trades] = await Promise.all([
          portfolioPromise,
          tradesPromise,
        ]);

        return {
          data: includeTrades ? { portfolio, trades } : portfolio,
          values: {},
          text: formatPortfolioProviderText({
            wallet: walletAddr,
            chain,
            portfolio,
            trades,
          }),
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        runtime.logger?.error(
          `Error fetching Birdeye portfolio: ${errorMessage}`,
        );

        const isConfigError =
          errorMessage.includes("BIRDEYE_CHAIN") ||
          errorMessage.includes("address") ||
          errorMessage.includes("Invalid");

        return {
          values: {},
          text: statusJson(
            "birdeye_wallet_portfolio",
            "error",
            isConfigError
              ? errorMessage
              : "unable to fetch wallet portfolio data",
          ),
          data: {},
        };
      }
    },
  };
}
