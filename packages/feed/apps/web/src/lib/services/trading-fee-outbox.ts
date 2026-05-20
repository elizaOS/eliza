/**
 * Durable queue for perp (and future) trading fees when inline processing fails after retries.
 *
 * Rows are removed in the same Postgres transaction as `FeeService.processTradingFee`
 * so a crash after charging cannot leave a stale row that would double-charge on retry.
 */

import type { TradingFeeOutboxPort } from '@feed/core/markets/shared';
import {
  db,
  dbWrite,
  eq,
  type Transaction,
  tradingFeeOutbox,
  withTransaction,
} from '@feed/db';
import { FeeService, type FeeType, isValidFeeType } from '@feed/engine';
import { generateSnowflakeId, logger } from '@feed/shared';
import { asc } from 'drizzle-orm';

const DRAIN_BATCH_SIZE = 50;

export async function enqueueFailedTradingFee(params: {
  userId: string;
  amount: number;
  type: string;
  relatedId: string;
  positionId: string;
  lastError?: string;
}): Promise<void> {
  const id = await generateSnowflakeId();
  await db.insert(tradingFeeOutbox).values({
    id,
    userId: params.userId,
    tradeType: params.type,
    tradeAmount: String(params.amount),
    tradeId: params.positionId,
    marketId: params.relatedId,
    lastError: params.lastError ?? null,
  });
}

export function createTradingFeeOutboxAdapter(): TradingFeeOutboxPort {
  return {
    enqueue: (p) => enqueueFailedTradingFee(p),
  };
}

export async function drainTradingFeeOutboxBatch(): Promise<{
  examined: number;
  processed: number;
  failed: number;
}> {
  // Drain must read from primary to avoid replica lag re-processing already-deleted rows.
  const rows = await dbWrite
    .select()
    .from(tradingFeeOutbox)
    .orderBy(asc(tradingFeeOutbox.createdAt))
    .limit(DRAIN_BATCH_SIZE);

  let processed = 0;
  let failed = 0;

  for (const row of rows) {
    // Validate tradeType before processing to catch invalid data early
    if (!isValidFeeType(row.tradeType)) {
      failed += 1;
      logger.error(
        'Invalid tradeType in outbox — skipping row',
        {
          outboxId: row.id,
          userId: row.userId,
          tradeType: row.tradeType,
        },
        'TradingFeeOutbox'
      );
      continue;
    }

    try {
      await withTransaction(async (tx: Transaction) => {
        await FeeService.processTradingFee(
          row.userId,
          row.tradeType as FeeType,
          Number(row.tradeAmount),
          row.tradeId ?? undefined,
          row.marketId ?? undefined,
          tx
        );
        await tx
          .delete(tradingFeeOutbox)
          .where(eq(tradingFeeOutbox.id, row.id));
      });
      processed += 1;
    } catch (error) {
      failed += 1;
      logger.error(
        'Trading fee outbox row failed (will retry on next drain)',
        {
          outboxId: row.id,
          userId: row.userId,
          tradeType: row.tradeType,
          error: error instanceof Error ? error.message : String(error),
        },
        'TradingFeeOutbox'
      );
    }
  }

  return { examined: rows.length, processed, failed };
}
