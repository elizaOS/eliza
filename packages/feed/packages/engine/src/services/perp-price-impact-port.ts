import {
  isOpenPerpPositionStateValid,
  PerpDbAdapter,
  type PriceImpactPort,
} from "@feed/core/markets/perps";
import {
  and,
  db,
  eq,
  isNull,
  organizationState,
  perpMarketSnapshots,
  perpPositions,
} from "@feed/db";
import {
  calculatePriceFromHoldings,
  logger,
  PERP_MARKET_CONFIG,
} from "@feed/shared";
import { PriceUpdateService } from "./price-update-service";

/**
 * Apply perp price impact for a ticker and return the resulting market price.
 *
 * This mirrors the real-time impact logic used by the web API and is shared
 * across A2A, MCP, agents, and engine trade execution paths.
 */
export async function applyPerpUserTradePriceImpact(
  ticker: string,
): Promise<number | undefined> {
  try {
    const normalizedTicker = ticker.toUpperCase();

    const [snapshot] = await db
      .select({
        organizationId: perpMarketSnapshots.organizationId,
        currentPrice: perpMarketSnapshots.currentPrice,
      })
      .from(perpMarketSnapshots)
      .where(eq(perpMarketSnapshots.ticker, normalizedTicker))
      .limit(1);

    if (!snapshot) {
      logger.warn(
        "PerpMarketSnapshot not found for price impact",
        { ticker: normalizedTicker },
        "PerpPriceImpact",
      );
      return undefined;
    }

    const [state] = await db
      .select({
        id: organizationState.id,
        currentPrice: organizationState.currentPrice,
        basePrice: organizationState.basePrice,
      })
      .from(organizationState)
      .where(eq(organizationState.id, snapshot.organizationId))
      .limit(1);

    if (!state) {
      logger.warn(
        "OrganizationState not found for price impact",
        { ticker: normalizedTicker, organizationId: snapshot.organizationId },
        "PerpPriceImpact",
      );
      return undefined;
    }

    const initialPrice = Number(
      state.basePrice ?? snapshot.currentPrice ?? 100,
    );
    const currentPrice = Number(
      snapshot.currentPrice ?? state.currentPrice ?? initialPrice,
    );

    const openPositions = await db
      .select({
        side: perpPositions.side,
        size: perpPositions.size,
        leverage: perpPositions.leverage,
        userId: perpPositions.userId,
      })
      .from(perpPositions)
      .where(
        and(
          eq(perpPositions.ticker, normalizedTicker),
          isNull(perpPositions.closedAt),
        ),
      );

    let netHoldings = 0;
    let invalidPositions = 0;
    for (const pos of openPositions) {
      if (!isOpenPerpPositionStateValid(pos)) {
        invalidPositions++;
        continue;
      }

      const size = Number(pos.size);
      netHoldings += pos.side === "long" ? size : -size;
    }

    if (invalidPositions > 0) {
      logger.warn(
        "Ignoring invalid open perp positions during price impact calculation",
        {
          ticker: normalizedTicker,
          invalidPositions,
        },
        "PerpPriceImpact",
      );
    }

    const newPrice = calculatePriceFromHoldings(
      initialPrice,
      currentPrice,
      netHoldings,
      PERP_MARKET_CONFIG,
    );

    if (Math.abs(newPrice - currentPrice) < 0.001) {
      return currentPrice;
    }

    await PriceUpdateService.applyUpdates([
      {
        organizationId: snapshot.organizationId,
        newPrice,
        source: "user_trade",
        reason: "User trade price impact",
        metadata: { ticker: normalizedTicker },
      },
    ]);

    const perpDb = new PerpDbAdapter();
    const markets = await perpDb.listMarkets();
    const market = markets.find(
      (m) => m.ticker.toUpperCase() === normalizedTicker,
    );

    return market?.currentPrice ?? newPrice;
  } catch (error) {
    logger.error(
      "Failed to apply user trade price impact",
      {
        ticker: ticker.toUpperCase(),
        error: error instanceof Error ? error.message : String(error),
      },
      "PerpPriceImpact",
    );
    return undefined;
  }
}

/**
 * Read base price for symmetric clamping in delta-based avg-fill logic.
 */
export async function getPerpBasePrice(
  ticker: string,
): Promise<number | undefined> {
  const normalizedTicker = ticker.toUpperCase();

  const [snapshot] = await db
    .select({ organizationId: perpMarketSnapshots.organizationId })
    .from(perpMarketSnapshots)
    .where(eq(perpMarketSnapshots.ticker, normalizedTicker))
    .limit(1);
  if (!snapshot) return undefined;

  const [state] = await db
    .select({ basePrice: organizationState.basePrice })
    .from(organizationState)
    .where(eq(organizationState.id, snapshot.organizationId))
    .limit(1);

  return state ? Number(state.basePrice ?? 100) : undefined;
}

/**
 * Shared adapter factory for PerpMarketService price impact protection.
 */
export function createPerpPriceImpactPort(): PriceImpactPort {
  return {
    applyAndGetPrice: applyPerpUserTradePriceImpact,
    getBasePrice: getPerpBasePrice,
  };
}
