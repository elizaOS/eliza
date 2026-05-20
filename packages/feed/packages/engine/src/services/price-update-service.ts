import { PerpDbAdapter, PerpMarketService } from '@babylon/core/markets/perps';
import {
  db,
  eq,
  getDbInstance,
  organizationState,
  organizations,
  perpMarketSnapshots,
} from '@babylon/db';
import type { JsonValue } from '@babylon/shared';
import { logger } from '@babylon/shared';
import { FEE_CONFIG } from '../config/fees';
import { broadcastToChannel } from './realtime-broadcaster';
import { WalletService } from './wallet-service';

export type PriceUpdateSource =
  | 'user_trade'
  | 'npc_trade'
  | 'event'
  | 'system'
  | 'volatility_simulation';

export interface PriceUpdateInput {
  organizationId: string;
  newPrice: number;
  source: PriceUpdateSource;
  reason?: string;
  metadata?: Record<string, JsonValue>;
}

export interface AppliedPriceUpdate {
  organizationId: string;
  oldPrice: number;
  newPrice: number;
  change: number;
  changePercent: number;
  source: PriceUpdateSource;
  reason?: string;
  metadata?: Record<string, JsonValue>;
  timestamp: string;
}

export class PriceUpdateService {
  private static getFirstPositivePrice(
    ...candidates: Array<number | null | undefined>
  ): number | null {
    for (const candidate of candidates) {
      if (
        typeof candidate === 'number' &&
        Number.isFinite(candidate) &&
        candidate > 0
      ) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * Apply a batch of price updates with persistence, engine sync, and SSE broadcast
   */
  static async applyUpdates(
    updates: PriceUpdateInput[]
  ): Promise<AppliedPriceUpdate[]> {
    if (updates.length === 0) return [];

    const perpService = new PerpMarketService({
      db: new PerpDbAdapter(),
      wallet: {
        debit: ({ userId, amount, reason, description, relatedId }) =>
          WalletService.debit(
            userId,
            amount,
            reason,
            description ?? '',
            relatedId
          ),
        credit: ({ userId, amount, reason, description, relatedId }) =>
          WalletService.credit(
            userId,
            amount,
            reason,
            description ?? '',
            relatedId
          ),
        recordPnL: async ({ userId, pnl, reason, relatedId }) => {
          await WalletService.recordPnL(userId, pnl, reason, relatedId);
        },
        getBalance: (userId: string) => WalletService.getBalance(userId),
      },
      fees: {
        tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
        platformShare: FEE_CONFIG.PLATFORM_SHARE,
        referrerShare: FEE_CONFIG.REFERRER_SHARE,
        minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
      },
    });
    const appliedUpdates: AppliedPriceUpdate[] = [];
    const priceMap = new Map<string, number>();
    const now = new Date();

    for (const update of updates) {
      if (!Number.isFinite(update.newPrice) || update.newPrice <= 0) {
        logger.warn(
          'Skipping invalid price update',
          { update },
          'PriceUpdateService'
        );
        continue;
      }

      const orgId = update.organizationId;

      // Prefer OrganizationState as the source of truth for dynamic pricing.
      // The `Organization` table is not guaranteed to be seeded in all envs.
      const [state] = await db
        .select({
          id: organizationState.id,
          currentPrice: organizationState.currentPrice,
          basePrice: organizationState.basePrice,
        })
        .from(organizationState)
        .where(eq(organizationState.id, orgId))
        .limit(1);

      // Best-effort: keep `Organization.currentPrice` in sync if the row exists.
      const [organization] = await db
        .select({
          id: organizations.id,
          currentPrice: organizations.currentPrice,
          initialPrice: organizations.initialPrice,
        })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);

      // Resolve basePrice for bounds enforcement
      // Priority: organizationState.basePrice > organization.initialPrice
      const resolvedBasePrice =
        this.getFirstPositivePrice(
          state?.basePrice,
          organization?.initialPrice
        ) ?? 100;

      // Price sanity check — must be positive and finite (AMM handles bounds)
      const clampedNewPrice = update.newPrice;
      if (!Number.isFinite(clampedNewPrice) || clampedNewPrice <= 0) {
        logger.warn(
          'Invalid price update value, skipping',
          { orgId, newPrice: update.newPrice },
          'PriceUpdateService'
        );
        continue;
      }

      const oldPriceCandidate =
        organization?.currentPrice ??
        state?.currentPrice ??
        state?.basePrice ??
        clampedNewPrice;
      const oldPrice = Number(oldPriceCandidate ?? clampedNewPrice);
      const change = clampedNewPrice - oldPrice;
      const changePercent = oldPrice === 0 ? 0 : (change / oldPrice) * 100;

      if (organization) {
        await db
          .update(organizations)
          .set({ currentPrice: clampedNewPrice, updatedAt: now })
          .where(eq(organizations.id, organization.id));
      }

      // Keep runtime price state in sync (used across engine + widgets)
      // Ensure basePrice is always set to prevent null fallback drift
      await db
        .insert(organizationState)
        .values({
          id: orgId,
          currentPrice: clampedNewPrice,
          basePrice: resolvedBasePrice,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: organizationState.id,
          set: {
            currentPrice: clampedNewPrice,
            basePrice: resolvedBasePrice,
            updatedAt: now,
          },
        });

      await getDbInstance().recordPriceUpdate(
        orgId,
        clampedNewPrice,
        change,
        changePercent
      );

      priceMap.set(orgId, clampedNewPrice);

      appliedUpdates.push({
        organizationId: orgId,
        oldPrice,
        newPrice: clampedNewPrice,
        change,
        changePercent,
        source: update.source,
        reason: update.reason,
        metadata: update.metadata,
        timestamp: new Date().toISOString(),
      });
    }

    if (priceMap.size > 0) {
      await perpService.applyPriceUpdates(priceMap);

      // Sync indexPrice: keep it within 5% of currentPrice so mark price
      // premium stays honest and microstructure spreads don't widen spuriously.
      // indexPrice is only set at bootstrap and never updated otherwise.
      const INDEX_DRIFT_THRESHOLD = 0.05;
      try {
        const snapshots = await db
          .select({
            ticker: perpMarketSnapshots.ticker,
            organizationId: perpMarketSnapshots.organizationId,
            currentPrice: perpMarketSnapshots.currentPrice,
            indexPrice: perpMarketSnapshots.indexPrice,
          })
          .from(perpMarketSnapshots);

        const indexUpdates: Array<{ ticker: string; indexPrice: number }> = [];
        for (const snap of snapshots) {
          const newCurrentPrice =
            priceMap.get(snap.organizationId) ?? snap.currentPrice;
          const idx = snap.indexPrice;
          if (idx == null || idx <= 0 || !Number.isFinite(idx)) {
            indexUpdates.push({
              ticker: snap.ticker,
              indexPrice: newCurrentPrice,
            });
            continue;
          }
          const drift = Math.abs(newCurrentPrice - idx) / idx;
          if (drift > INDEX_DRIFT_THRESHOLD) {
            indexUpdates.push({
              ticker: snap.ticker,
              indexPrice: newCurrentPrice,
            });
          }
        }

        await Promise.all(
          indexUpdates.map((update) =>
            db
              .update(perpMarketSnapshots)
              .set({ indexPrice: update.indexPrice, updatedAt: now })
              .where(eq(perpMarketSnapshots.ticker, update.ticker))
          )
        );

        if (indexUpdates.length > 0) {
          logger.debug(
            `Synced indexPrice for ${indexUpdates.length} perp market(s)`,
            { tickers: indexUpdates.map((u) => u.ticker) },
            'PriceUpdateService'
          );
        }
      } catch (err) {
        logger.warn(
          'Failed to sync perp indexPrice',
          { err },
          'PriceUpdateService'
        );
      }

      // Broadcast price updates (handled by API layer if available)
      try {
        const updatesForBroadcast: JsonValue = appliedUpdates.map((u) => ({
          organizationId: u.organizationId,
          oldPrice: u.oldPrice,
          newPrice: u.newPrice,
          change: u.change,
          changePercent: u.changePercent,
          source: u.source,
          reason: u.reason ?? null,
          metadata: u.metadata ?? null,
          timestamp: u.timestamp,
        }));

        await broadcastToChannel('markets', {
          type: 'price_update',
          updates: updatesForBroadcast,
        });

        const marketsByTicker = new Map(
          (await perpService.getMarketsSnapshot()).map((market) => [
            market.ticker.toUpperCase(),
            market,
          ])
        );

        // If any updates include a canonical perp ticker, also broadcast a
        // `perp_price_update` for real-time UI hooks/stores.
        const perpUpdates = appliedUpdates
          .map((u) => {
            const tickerRaw = u.metadata?.ticker;
            const ticker =
              typeof tickerRaw === 'string' && tickerRaw.length > 0
                ? tickerRaw.toUpperCase()
                : null;
            if (!ticker) return null;
            const market = marketsByTicker.get(ticker);
            return {
              ticker,
              organizationId: u.organizationId,
              newPrice: u.newPrice,
              price: u.newPrice,
              change: u.change,
              changePercent: u.changePercent,
              ...(market?.bidPrice !== undefined && {
                bidPrice: market.bidPrice,
              }),
              ...(market?.askPrice !== undefined && {
                askPrice: market.askPrice,
              }),
              ...(market?.spreadBps !== undefined && {
                spreadBps: market.spreadBps,
              }),
              ...(market?.bidDepth !== undefined && {
                bidDepth: market.bidDepth,
              }),
              ...(market?.askDepth !== undefined && {
                askDepth: market.askDepth,
              }),
              ...(market?.liquidityRegime !== undefined && {
                liquidityRegime: market.liquidityRegime,
              }),
            };
          })
          .filter((u): u is NonNullable<typeof u> => u !== null);

        if (perpUpdates.length > 0) {
          await broadcastToChannel('markets', {
            type: 'perp_price_update',
            updates: perpUpdates,
          });
        }
      } catch {
        // Broadcast is optional - engine can work without it
      }

      logger.info(
        `Applied ${appliedUpdates.length} organization price updates`,
        { count: appliedUpdates.length },
        'PriceUpdateService'
      );
    }

    return appliedUpdates;
  }
}
