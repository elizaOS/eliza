import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { BIRDEYE_SERVICE_NAME } from "../constants";
import type {
  WalletPortfolioResponse,
  WalletTransactionHistoryResponse,
} from "../types/api/wallet";
import type {
  BirdeyeSupportedChain,
  GetCacheTimedOptions,
} from "../types/shared";
import { extractChain, formatJsonScalar, formatJsonTable } from "../utils";

type PortfolioData = WalletPortfolioResponse["data"];
type WalletTransaction =
  WalletTransactionHistoryResponse["data"][string][number];
type PortfolioResult = PortfolioData | false;
type TradesResult = WalletTransaction[] | false | undefined;

type PortfolioService = {
  fetchWalletTokenList: (
    chain: BirdeyeSupportedChain,
    walletAddr: string,
    opts: GetCacheTimedOptions,
  ) => Promise<PortfolioResult>;
  fetchWalletTxList?: (
    chain: BirdeyeSupportedChain,
    walletAddr: string,
    opts: GetCacheTimedOptions,
  ) => Promise<WalletTransaction[] | false>;
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

function settingAsString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasPortfolioItems(value: unknown): value is PortfolioData {
  return isRecord(value) && Array.isArray(value.items);
}

function normalizePortfolioResponse(
  response: PortfolioData | WalletPortfolioResponse | false | undefined,
): PortfolioData {
  const wrappedData =
    isRecord(response) && "data" in response ? response.data : undefined;
  if (hasPortfolioItems(wrappedData)) {
    return wrappedData;
  }
  if (hasPortfolioItems(response)) {
    return response;
  }
  return { items: [] };
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
  portfolio: PortfolioResult;
  trades?: TradesResult;
}): string {
  const normalized = normalizePortfolioResponse(portfolio);
  const holdings = normalized.items ?? [];
  const tradeRows = Array.isArray(trades) ? trades : undefined;
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

  if (tradeRows) {
    lines.push(`  tradeCount: ${tradeRows.length}`);
    lines.push(
      formatJsonTable(
        "  trades",
        tradeRows.slice(0, 10).map((trade) => ({
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
    | Partial<PortfolioService>
    | undefined;
  if (!beService || typeof beService.fetchWalletTokenList !== "function") {
    return undefined;
  }
  if (includeTrades && typeof beService.fetchWalletTxList !== "function") {
    return undefined;
  }
  return {
    fetchWalletTokenList: beService.fetchWalletTokenList,
    fetchWalletTxList: beService.fetchWalletTxList,
  };
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
    get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
      try {
        const walletAddr = settingAsString(
          runtime.getSetting("BIRDEYE_WALLET_ADDR"),
        );
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

        const explicitChain = settingAsString(
          runtime.getSetting("BIRDEYE_CHAIN"),
        );
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
        const tradesPromise: Promise<TradesResult> =
          includeTrades && beService.fetchWalletTxList
            ? beService.fetchWalletTxList(chain, walletAddr, {
                notOlderThan: 30 * 1000,
              })
            : Promise.resolve(undefined);
        const [portfolio, trades] = await Promise.all([
          portfolioPromise,
          tradesPromise,
        ]);

        return {
          data: includeTrades ? { portfolio, trades } : { portfolio },
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
