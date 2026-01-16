import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  ProviderValue,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { DEFAULT_CLOB_API_URL, POLYGON_CHAIN_ID, POLYMARKET_SERVICE_NAME } from "../constants";
import type { PolymarketService } from "../services/polymarket";
import type {
  ActivityContext,
  ActivityCursor,
  CachedAccountState,
  MarketDetailsActivityData,
  MarketsActivityData,
  OpenOrder,
  OrderDetailsActivityData,
  OrderScoringActivityData,
  PriceHistoryActivityData,
  TradeHistoryActivityData,
} from "../types";

function parseBooleanSetting(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function formatAccountStateText(accountState: CachedAccountState): string {
  const lines: string[] = [];

  lines.push(`Wallet: ${accountState.walletAddress}`);

  if (accountState.balances.collateral) {
    lines.push(`USDC Balance: ${accountState.balances.collateral.balance}`);
    lines.push(`USDC Allowance: ${accountState.balances.collateral.allowance}`);
  } else {
    lines.push(`USDC Balance: Unable to fetch (check API credentials)`);
  }

  if (accountState.activeOrders.length > 0) {
    const scoringCount = Object.values(accountState.orderScoringStatus).filter((v) => v).length;
    lines.push(`Active Orders: ${accountState.activeOrders.length} (${scoringCount} scoring)`);
    const orderSummaries = accountState.activeOrders.slice(0, 5).map((o: OpenOrder) => {
      const isScoring = accountState.orderScoringStatus[o.id];
      const scoringIndicator = isScoring ? " [SCORING]" : "";
      return `  - ${o.side} ${o.original_size} @ $${parseFloat(o.price).toFixed(4)} (${o.status})${scoringIndicator}`;
    });
    lines.push(...orderSummaries);
    if (accountState.activeOrders.length > 5) {
      lines.push(`  ... and ${accountState.activeOrders.length - 5} more orders`);
    }
  } else {
    lines.push("Active Orders: None");
  }

  if (accountState.recentTrades.length > 0) {
    lines.push(`Recent Trades: ${accountState.recentTrades.length}`);
  }

  // Use cached positions from account state
  if (accountState.positions.length > 0) {
    lines.push(`Open Positions: ${accountState.positions.length}`);
    const posSummaries = accountState.positions.slice(0, 5).map((p) => {
      const pnl = parseFloat(p.realized_pnl);
      const pnlSign = pnl >= 0 ? "+" : "";
      return `  - ${p.asset_id.substring(0, 8)}...: ${p.size} @ avg $${p.average_price} (PnL: ${pnlSign}${p.realized_pnl})`;
    });
    lines.push(...posSummaries);
  }

  const ageMs = Date.now() - accountState.lastUpdatedAt;
  const ageMinutes = Math.floor(ageMs / 60000);
  lines.push(`Last Updated: ${ageMinutes} minute(s) ago`);

  return lines.join("\n");
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);

  if (diffMinutes < 1) {
    return "just now";
  }
  if (diffMinutes < 60) {
    return `${diffMinutes} minute(s) ago`;
  }
  if (diffHours < 24) {
    return `${diffHours} hour(s) ago`;
  }
  return `${Math.floor(diffHours / 24)} day(s) ago`;
}

function formatActivityCursor(cursor: ActivityCursor): string {
  const timeAgo = formatRelativeTime(cursor.timestamp);
  const data = cursor.data;

  switch (data.type) {
    case "markets_list": {
      const marketsData = data as MarketsActivityData;
      let text = `Viewed ${marketsData.count} market(s) (${marketsData.mode} mode) ${timeAgo}`;
      if (marketsData.tags && marketsData.tags.length > 0) {
        text += ` [tags: ${marketsData.tags.join(", ")}]`;
      }
      if (marketsData.markets.length > 0) {
        const marketsList = marketsData.markets
          .slice(0, 3)
          .map((m) => `"${m.question.substring(0, 50)}${m.question.length > 50 ? "..." : ""}"`)
          .join(", ");
        text += `\n  Markets: ${marketsList}`;
        if (marketsData.markets.length > 3) {
          text += ` (+${marketsData.markets.length - 3} more)`;
        }
      }
      return text;
    }

    case "market_details": {
      const detailsData = data as MarketDetailsActivityData;
      return `Viewed market details ${timeAgo}\n  Question: "${detailsData.question}"\n  ID: ${detailsData.conditionId.substring(0, 16)}...\n  Status: ${detailsData.active ? "Active" : "Inactive"}, ${detailsData.closed ? "Closed" : "Open"}`;
    }

    case "order_details": {
      const orderData = data as OrderDetailsActivityData;
      return `Viewed order details ${timeAgo}\n  Order ID: ${orderData.orderId}\n  Status: ${orderData.status}, ${orderData.side} @ $${parseFloat(orderData.price).toFixed(4)}\n  Size: ${orderData.originalSize} (matched: ${orderData.sizeMatched})`;
    }

    case "price_history": {
      const priceData = data as PriceHistoryActivityData;
      let text = `Viewed price history ${timeAgo}\n  Token: ${priceData.tokenId.substring(0, 16)}...\n  Data points: ${priceData.dataPoints}`;
      if (priceData.startPrice && priceData.endPrice) {
        text += `\n  Price: $${priceData.startPrice} -> $${priceData.endPrice}`;
        if (priceData.priceChangePercent) {
          text += ` (${priceData.priceChangePercent}%)`;
        }
      }
      return text;
    }

    case "trade_history": {
      const tradeData = data as TradeHistoryActivityData;
      let text = `Viewed trade history ${timeAgo}\n  Total trades: ${tradeData.totalTrades}`;
      if (tradeData.filterMarket) {
        text += ` [market: ${tradeData.filterMarket}]`;
      }
      if (tradeData.recentTrades.length > 0) {
        const tradesList = tradeData.recentTrades
          .slice(0, 3)
          .map((t) => `${t.side} ${t.size} @ $${parseFloat(t.price).toFixed(4)}`)
          .join(", ");
        text += `\n  Recent: ${tradesList}`;
      }
      return text;
    }

    case "order_scoring": {
      const scoringData = data as OrderScoringActivityData;
      return `Checked order scoring ${timeAgo}\n  Orders checked: ${scoringData.orderIds.length}\n  Scoring: ${scoringData.scoringCount}, Not scoring: ${scoringData.notScoringCount}`;
    }

    default:
      return `Activity ${timeAgo}`;
  }
}

function formatActivityContextText(activityContext: ActivityContext): string {
  const lines: string[] = [];

  lines.push("=== Recent Activity (Context) ===");

  // Show the most recent activity first
  if (activityContext.recentHistory.length > 0) {
    lines.push("\nLast actions:");
    activityContext.recentHistory.slice(0, 5).forEach((cursor, index) => {
      lines.push(`${index + 1}. ${formatActivityCursor(cursor)}`);
    });
  } else {
    lines.push("No recent activity recorded.");
  }

  return lines.join("\n");
}

export const polymarketProvider: Provider = {
  name: "POLYMARKET_PROVIDER",
  description:
    "Provides current Polymarket account state and trading context from the service cache",

  get: async (runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> => {
    const clobApiUrl = runtime.getSetting("CLOB_API_URL") || DEFAULT_CLOB_API_URL;
    const hasPrivateKey = Boolean(
      runtime.getSetting("POLYMARKET_PRIVATE_KEY") ||
        runtime.getSetting("EVM_PRIVATE_KEY") ||
        runtime.getSetting("WALLET_PRIVATE_KEY"),
    );
    const hasEnvApiCreds = Boolean(
      runtime.getSetting("CLOB_API_KEY") && runtime.getSetting("CLOB_API_SECRET"),
    );
    const allowCreateSetting = runtime.getSetting("POLYMARKET_ALLOW_CREATE_API_KEY");
    const canDeriveOrCreateCreds =
      hasPrivateKey && allowCreateSetting !== "false" && allowCreateSetting !== false;
    const hasApiCreds = hasEnvApiCreds || canDeriveOrCreateCreds;

    const strictSetting = runtime.getSetting("POLYMARKET_PROVIDER_STRICT");
    const strictMode =
      strictSetting === undefined ? true : parseBooleanSetting(String(strictSetting));

    const featuresAvailable: string[] = ["market_data", "price_feeds", "order_book"];
    if (hasPrivateKey) {
      featuresAvailable.push("wallet_operations");
    }
    if (hasApiCreds) {
      featuresAvailable.push("authenticated_trading", "order_management");
    }

    // Get the service to read cached account state
    const service = runtime.getService(POLYMARKET_SERVICE_NAME) as PolymarketService | undefined;

    if (strictMode && !hasApiCreds) {
      throw new Error(
        "Polymarket provider strict mode: API credentials required to fetch trading context. " +
          "Set CLOB_API_KEY/SECRET/PASSPHRASE or enable POLYMARKET_ALLOW_CREATE_API_KEY with a private key.",
      );
    }

    if (hasApiCreds && strictMode && !hasPrivateKey) {
      throw new Error(
        "Polymarket provider strict mode: private key required when API credentials are set.",
      );
    }

    // Build the provider values from service cache
    const values: Record<string, ProviderValue> = {
      clobApiUrl,
      chainId: POLYGON_CHAIN_ID,
      serviceStatus: service ? "active" : "not_initialized",
      hasPrivateKey,
      hasApiCreds,
      strictMode,
      featuresAvailable,
    };

    let accountStateText = "";
    let providerError: string | null = null;

    if (service && hasApiCreds) {
      try {
        // Get cached account state - never trigger API calls from provider
        // Service refreshes cache in background on interval
        const accountState = service.getCachedAccountState();

        if (accountState) {
          values.walletAddress = accountState.walletAddress;

          if (accountState.balances.collateral) {
            values.collateralBalance = { ...accountState.balances.collateral };
          }

          if (Object.keys(accountState.balances.conditionalTokens).length > 0) {
            values.conditionalBalances = { ...accountState.balances.conditionalTokens };
          }

          if (accountState.recentTrades.length > 0) {
            values.recentTrades = accountState.recentTrades;
          }

          if (accountState.activeOrders.length > 0) {
            values.activeOrders = accountState.activeOrders;
          }

          // Use cached positions from account state
          if (accountState.positions.length > 0) {
            values.positions = accountState.positions;
          }

          // Include order scoring status
          if (Object.keys(accountState.orderScoringStatus).length > 0) {
            values.orderScoringStatus = accountState.orderScoringStatus;
          }

          values.apiKeysCount = accountState.apiKeys.length;
          values.certRequired = accountState.certRequired;
          values.accountStateLastUpdated = accountState.lastUpdatedAt;
          values.accountStateExpiresAt = accountState.expiresAt;

          accountStateText = formatAccountStateText(accountState);
        } else if (strictMode) {
          throw new Error("Polymarket provider strict mode: account state unavailable.");
        }
      } catch (error) {
        providerError = error instanceof Error ? error.message : String(error);
        logger.error("[polymarketProvider] Failed to get account state:", providerError);
        if (strictMode) {
          throw error;
        }
      }
    } else if (!service) {
      providerError = "Polymarket service not initialized";
      logger.warn("[polymarketProvider] Service not available");
    }

    if (providerError) {
      values.providerError = providerError;
    }

    // Get activity context from memory cache (synchronous, never blocks)
    let activityContextText = "";
    if (service) {
      const activityContext = service.getCachedActivityContext();
      if (activityContext && activityContext.recentHistory.length > 0) {
        activityContextText = formatActivityContextText(activityContext);
        values.hasActivityContext = true;
        values.lastActivityType = activityContext.recentHistory[0]?.data.type;
        values.activityCount = activityContext.recentHistory.length;
      }
    }

    const baseText =
      `Connected to Polymarket CLOB at ${clobApiUrl} on Polygon (Chain ID: ${POLYGON_CHAIN_ID}). ` +
      `Features available: ${featuresAvailable.join(", ")}.`;

    // Build full text with account state and activity context
    let fullText = baseText;
    if (accountStateText) {
      fullText += `\n\n${accountStateText}`;
    }
    if (activityContextText) {
      fullText += `\n\n${activityContextText}`;
    }

    const result: ProviderResult = {
      text: fullText,
      values,
      data: {
        timestamp: new Date().toISOString(),
        service: "polymarket",
      },
    };

    return result;
  },
};
