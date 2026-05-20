import {
  type PerpPosition as DbPerpPosition,
  db as defaultDb,
  organizations,
  perpMarketSnapshots,
  perpPositions,
  type Transaction,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import type { InferInsertModel } from 'drizzle-orm';
import { and, asc, count, eq, isNull } from 'drizzle-orm';
import type {
  PerpDbPort,
  PerpMarketRecord,
  PerpPositionRecord,
  PerpSide,
} from '../../types';

type NewPerpPosition = InferInsertModel<typeof perpPositions>;
type DrizzleClient = typeof defaultDb | Transaction;

/**
 * Drizzle adapter for PerpDbPort.
 *
 * Notes:
 * - Uses PerpMarketSnapshot as single source for market-level stats.
 * - Generates IDs via snowflake when none provided.
 * - Supports transactions via constructor injection or transaction() method.
 */
export class PerpDbAdapter implements PerpDbPort {
  private readonly dbClient: DrizzleClient;

  constructor(dbClient?: DrizzleClient) {
    this.dbClient = dbClient ?? defaultDb;
  }

  /**
   * WHY no WHERE clause: countMarkets counts everything in perpMarketSnapshots,
   * matching what listMarkets() returns without options. The perps table has one
   * row per ticker (snapshot, not historical), so count = number of instruments.
   */
  async countMarkets(): Promise<number> {
    const [row] = await this.dbClient
      .select({ c: count() })
      .from(perpMarketSnapshots);
    return Number(row?.c ?? 0);
  }

  /**
   * WHY orderBy ticker ASC: Ensures deterministic page boundaries. Without a
   * stable sort, rows can shift between pages as prices change, causing
   * duplicates or gaps in paginated responses.
   */
  async listMarkets(options?: {
    limit?: number;
    offset?: number;
  }): Promise<PerpMarketRecord[]> {
    const base = this.dbClient
      .select({
        s: perpMarketSnapshots,
        orgName: organizations.name,
        orgImage: organizations.imageUrl,
      })
      .from(perpMarketSnapshots)
      .leftJoin(
        organizations,
        eq(perpMarketSnapshots.organizationId, organizations.id)
      )
      .orderBy(asc(perpMarketSnapshots.ticker));
    const rows =
      options?.limit != null
        ? await base.limit(options.limit).offset(options.offset ?? 0)
        : await base;
    if (rows.length === 0) return [];

    return rows.map(({ s, orgName, orgImage }) => ({
      ticker: s.ticker,
      organizationId: s.organizationId,
      name: orgName ?? s.name ?? undefined,
      imageUrl: orgImage ?? null,
      currentPrice: Number(s.currentPrice),
      price24hAgo: s.price24hAgo ? Number(s.price24hAgo) : undefined,
      change24h: Number(s.change24h ?? 0),
      changePercent24h: Number(s.changePercent24h ?? 0),
      high24h: Number(s.high24h),
      low24h: Number(s.low24h),
      volume24h: Number(s.volume24h ?? 0),
      openInterest: Number(s.openInterest ?? 0),
      fundingRate: (s.fundingRate ?? {
        ticker: s.ticker,
        rate: 0,
        nextFundingTime: new Date().toISOString(),
        predictedRate: 0,
      }) as PerpMarketRecord['fundingRate'],
      maxLeverage: Number(s.maxLeverage ?? 100),
      minOrderSize: Number(s.minOrderSize ?? 10),
      bidPrice: s.bidPrice ? Number(s.bidPrice) : undefined,
      askPrice: s.askPrice ? Number(s.askPrice) : undefined,
      spreadBps: s.spreadBps ? Number(s.spreadBps) : undefined,
      bidDepth: s.bidDepth ? Number(s.bidDepth) : undefined,
      askDepth: s.askDepth ? Number(s.askDepth) : undefined,
      liquidityRegime:
        (s.liquidityRegime as PerpMarketRecord['liquidityRegime']) ?? undefined,
      quoteUpdatedAt: s.quoteUpdatedAt ?? undefined,
      markPrice: s.markPrice ? Number(s.markPrice) : undefined,
      indexPrice: s.indexPrice ? Number(s.indexPrice) : undefined,
    }));
  }

  async listOpenPositions(): Promise<PerpPositionRecord[]> {
    const positions = await this.dbClient
      .select()
      .from(perpPositions)
      .where(isNull(perpPositions.closedAt));

    return positions.map(mapPosition);
  }

  async getPositionById(id: string): Promise<PerpPositionRecord | null> {
    const [pos] = await this.dbClient
      .select()
      .from(perpPositions)
      .where(eq(perpPositions.id, id))
      .limit(1);
    return pos ? mapPosition(pos) : null;
  }

  async getOpenPositionsByUser(userId: string): Promise<PerpPositionRecord[]> {
    const positions = await this.dbClient
      .select()
      .from(perpPositions)
      .where(
        and(eq(perpPositions.userId, userId), isNull(perpPositions.closedAt))
      );
    return positions.map(mapPosition);
  }

  async getOpenPositionByUserAndTicker(
    userId: string,
    ticker: string
  ): Promise<PerpPositionRecord | null> {
    const [pos] = await this.dbClient
      .select()
      .from(perpPositions)
      .where(
        and(
          eq(perpPositions.userId, userId),
          eq(perpPositions.ticker, ticker),
          isNull(perpPositions.closedAt)
        )
      )
      .limit(1);
    return pos ? mapPosition(pos) : null;
  }

  async lockOpenPositionById(id: string): Promise<PerpPositionRecord | null> {
    const [pos] = await this.dbClient
      .select()
      .from(perpPositions)
      .where(and(eq(perpPositions.id, id), isNull(perpPositions.closedAt)))
      .limit(1)
      .for('update');
    return pos ? mapPosition(pos) : null;
  }

  async upsertPosition(
    position: Omit<PerpPositionRecord, 'id'> & { id?: string }
  ): Promise<PerpPositionRecord> {
    const now = new Date();
    const id = position.id ?? (await generateSnowflakeId());
    const insert: NewPerpPosition = {
      id,
      userId: position.userId,
      ticker: position.ticker,
      organizationId: position.organizationId,
      side: position.side,
      entryPrice: position.entryPrice,
      currentPrice: position.currentPrice,
      size: position.size,
      leverage: position.leverage,
      liquidationPrice: position.liquidationPrice,
      unrealizedPnL: position.unrealizedPnL,
      unrealizedPnLPercent: position.unrealizedPnLPercent,
      fundingPaid: position.fundingPaid,
      openedAt: position.openedAt ?? now,
      lastUpdated: position.lastUpdated ?? now,
      closedAt: position.closedAt ?? null,
      realizedPnL: position.realizedPnL ?? null,
    };

    const result = await this.dbClient
      .insert(perpPositions)
      .values(insert)
      .onConflictDoUpdate({
        target: perpPositions.id,
        set: { ...insert, openedAt: insert.openedAt },
      })
      .returning()
      .execute();

    return mapPosition(result[0]!);
  }

  async updateOpenPosition(
    positionId: string,
    updates: Partial<
      Pick<
        PerpPositionRecord,
        | 'currentPrice'
        | 'unrealizedPnL'
        | 'unrealizedPnLPercent'
        | 'fundingPaid'
        | 'liquidationPrice'
        | 'lastUpdated'
        | 'size'
        | 'entryPrice'
      >
    >
  ): Promise<void> {
    // Only set fields that are explicitly provided (not undefined)
    const setFields: Record<string, unknown> = {
      lastUpdated: updates.lastUpdated ?? new Date(),
    };
    if (updates.currentPrice !== undefined) {
      setFields.currentPrice = updates.currentPrice;
    }
    if (updates.unrealizedPnL !== undefined) {
      setFields.unrealizedPnL = updates.unrealizedPnL;
    }
    if (updates.unrealizedPnLPercent !== undefined) {
      setFields.unrealizedPnLPercent = updates.unrealizedPnLPercent;
    }
    if (updates.fundingPaid !== undefined) {
      setFields.fundingPaid = updates.fundingPaid;
    }
    if (updates.liquidationPrice !== undefined) {
      setFields.liquidationPrice = updates.liquidationPrice;
    }
    if (updates.size !== undefined) {
      setFields.size = updates.size;
    }
    if (updates.entryPrice !== undefined) {
      setFields.entryPrice = updates.entryPrice;
    }

    await this.dbClient
      .update(perpPositions)
      .set(setFields)
      .where(
        and(eq(perpPositions.id, positionId), isNull(perpPositions.closedAt))
      );
  }

  async closePosition(
    positionId: string,
    updates: Partial<
      Pick<
        PerpPositionRecord,
        | 'currentPrice'
        | 'closedAt'
        | 'realizedPnL'
        | 'unrealizedPnL'
        | 'unrealizedPnLPercent'
      >
    >
  ): Promise<void> {
    const closedAt = updates.closedAt ?? new Date();
    // Only set fields that are explicitly provided (not undefined)
    const setFields: Record<string, unknown> = {
      closedAt,
      lastUpdated: closedAt,
      unrealizedPnL: updates.unrealizedPnL ?? 0,
      unrealizedPnLPercent: updates.unrealizedPnLPercent ?? 0,
    };
    if (updates.currentPrice !== undefined) {
      setFields.currentPrice = updates.currentPrice;
    }
    if (updates.realizedPnL !== undefined) {
      setFields.realizedPnL = updates.realizedPnL;
    }

    await this.dbClient
      .update(perpPositions)
      .set(setFields)
      .where(
        and(eq(perpPositions.id, positionId), isNull(perpPositions.closedAt))
      );
  }

  async updateMarketStats(
    ticker: string,
    updates: Partial<
      Pick<
        PerpMarketRecord,
        | 'currentPrice'
        | 'price24hAgo'
        | 'change24h'
        | 'changePercent24h'
        | 'high24h'
        | 'low24h'
        | 'volume24h'
        | 'openInterest'
        | 'fundingRate'
        | 'bidPrice'
        | 'askPrice'
        | 'spreadBps'
        | 'bidDepth'
        | 'askDepth'
        | 'liquidityRegime'
        | 'quoteUpdatedAt'
        | 'markPrice'
        | 'indexPrice'
        | 'maxLeverage'
        | 'minOrderSize'
      >
    >
  ): Promise<void> {
    const now = new Date();
    const existing = await this.dbClient
      .select()
      .from(perpMarketSnapshots)
      .where(eq(perpMarketSnapshots.ticker, ticker))
      .limit(1);

    if (existing.length === 0) {
      // Snapshot must be seeded separately - this method only updates existing snapshots
      // Use init-snapshots script in @feed/engine to seed from static organization data
      throw new Error(
        `Cannot update market snapshot for ${ticker}: snapshot not found. ` +
          'Run perp market seeding to create snapshots from static organization data.'
      );
    }

    const current = existing[0]!;
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

    // Rotate price24hAgo if more than 24 hours have passed since last rotation
    let price24hAgo = updates.price24hAgo ?? current.price24hAgo;
    let price24hAgoUpdatedAt = current.price24hAgoUpdatedAt;

    if (
      !price24hAgoUpdatedAt ||
      now.getTime() - price24hAgoUpdatedAt.getTime() >= TWENTY_FOUR_HOURS
    ) {
      // Time to rotate: current price becomes price24hAgo
      price24hAgo = current.currentPrice;
      price24hAgoUpdatedAt = now;
    }

    // Reset 24h metrics (high/low/volume) if more than 24 hours have passed
    let high24h = updates.high24h ?? current.high24h;
    let low24h = updates.low24h ?? current.low24h;
    let volume24h = updates.volume24h ?? current.volume24h;
    let metrics24hResetAt = current.metrics24hResetAt;

    if (
      !metrics24hResetAt ||
      now.getTime() - metrics24hResetAt.getTime() >= TWENTY_FOUR_HOURS
    ) {
      // Reset: use current price as starting point for high/low, zero volume
      const currentPrice = updates.currentPrice ?? current.currentPrice;
      high24h = updates.high24h ?? currentPrice;
      low24h = updates.low24h ?? currentPrice;
      volume24h = updates.volume24h ?? 0;
      metrics24hResetAt = now;
    }

    await this.dbClient
      .update(perpMarketSnapshots)
      .set({
        currentPrice: updates.currentPrice ?? current.currentPrice,
        price24hAgo,
        price24hAgoUpdatedAt,
        metrics24hResetAt,
        change24h: updates.change24h ?? current.change24h,
        changePercent24h: updates.changePercent24h ?? current.changePercent24h,
        high24h,
        low24h,
        volume24h,
        openInterest: updates.openInterest ?? current.openInterest,
        fundingRate: updates.fundingRate ?? current.fundingRate,
        maxLeverage: updates.maxLeverage ?? current.maxLeverage,
        minOrderSize: updates.minOrderSize ?? current.minOrderSize,
        bidPrice: updates.bidPrice ?? current.bidPrice,
        askPrice: updates.askPrice ?? current.askPrice,
        spreadBps: updates.spreadBps ?? current.spreadBps,
        bidDepth: updates.bidDepth ?? current.bidDepth,
        askDepth: updates.askDepth ?? current.askDepth,
        liquidityRegime: updates.liquidityRegime ?? current.liquidityRegime,
        quoteUpdatedAt: updates.quoteUpdatedAt ?? current.quoteUpdatedAt,
        markPrice: updates.markPrice ?? current.markPrice,
        indexPrice: updates.indexPrice ?? current.indexPrice,
        updatedAt: now,
      })
      .where(eq(perpMarketSnapshots.ticker, ticker));
  }

  /**
   * Execute operations within a transaction for atomicity.
   * Creates a new PerpDbAdapter bound to the transaction context.
   */
  async transaction<T>(fn: (tx: PerpDbPort) => Promise<T>): Promise<T> {
    // If already in a transaction, just use the current client
    if (this.dbClient !== defaultDb) {
      return fn(this);
    }

    return defaultDb.transaction(async (txClient) => {
      const txAdapter = new PerpDbAdapter(txClient);
      return fn(txAdapter);
    });
  }
}

function mapPosition(pos: DbPerpPosition): PerpPositionRecord {
  return {
    id: pos.id,
    userId: pos.userId,
    ticker: pos.ticker,
    organizationId: pos.organizationId,
    side: pos.side as PerpSide,
    entryPrice: Number(pos.entryPrice),
    currentPrice: Number(pos.currentPrice),
    size: Number(pos.size),
    leverage: Number(pos.leverage),
    liquidationPrice: Number(pos.liquidationPrice),
    unrealizedPnL: Number(pos.unrealizedPnL),
    unrealizedPnLPercent: Number(pos.unrealizedPnLPercent),
    fundingPaid: Number(pos.fundingPaid),
    openedAt: new Date(pos.openedAt),
    lastUpdated: new Date(pos.lastUpdated),
    closedAt: pos.closedAt ? new Date(pos.closedAt) : undefined,
    realizedPnL: pos.realizedPnL !== null ? Number(pos.realizedPnL) : undefined,
  };
}
