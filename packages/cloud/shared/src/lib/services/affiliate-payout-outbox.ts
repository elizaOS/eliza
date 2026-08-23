/**
 * Durable handoff from collected affiliate markup to the redeemable earnings
 * ledger. Reservation settlement enqueues atomically; inline and cron workers
 * may then race safely because both layers use the same global source identity.
 */

import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { type SqlExecutor, sqlRows } from "../../db/execute-helpers";
import { dbWrite } from "../../db/helpers";
import { normalizeLedgerSourceId } from "../utils/ledger-source-id";
import { logger } from "../utils/logger";
import {
  type AffiliateBillingAttribution,
  isAffiliateBillingAttribution,
} from "./affiliate-billing-attribution";
import { redeemableEarningsService } from "./redeemable-earnings";

export const AFFILIATE_PAYOUT_CONTRACT_VERSION = 1;

export interface AffiliatePayoutSettlementContract {
  version: typeof AFFILIATE_PAYOUT_CONTRACT_VERSION;
  sourceId: string;
  attribution: AffiliateBillingAttribution;
  model: string;
}

interface AffiliatePayoutOutboxSqlRow {
  id: string;
  source_id: string;
  affiliate_code_id: string;
  affiliate_user_id: string;
  amount: string | number;
  description: string;
  metadata: Record<string, unknown> | string;
  attempts: number | string;
  processed_at: Date | string | null;
  ledger_entry_id: string | null;
}

interface AffiliatePayoutLedgerSqlRow {
  id: string;
  user_id: string;
  entry_type: string;
  amount: string | number;
  earnings_source: string | null;
  source_id: string | null;
  description: string;
  metadata: Record<string, unknown> | string;
}

export class AffiliatePayoutContractError extends Error {
  constructor(message: string) {
    super(`Invalid affiliate payout contract: ${message}`);
    this.name = "AffiliatePayoutContractError";
  }
}

export class AffiliatePayoutReplayMismatchError extends Error {
  constructor(readonly sourceId: string) {
    super(`Affiliate payout replay mismatch for ${sourceId}`);
    this.name = "AffiliatePayoutReplayMismatchError";
  }
}

function parseMetadata(value: AffiliatePayoutOutboxSqlRow["metadata"]): Record<string, unknown> {
  if (typeof value !== "string") return value;
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AffiliatePayoutContractError("outbox metadata is not an object");
  }
  return parsed as Record<string, unknown>;
}

function parseSettlementContract(value: unknown): AffiliatePayoutSettlementContract | null {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AffiliatePayoutContractError("affiliatePayout is not an object");
  }
  const contract = value as Record<string, unknown>;
  const { sourceId, model, attribution } = contract;
  if (
    contract.version !== AFFILIATE_PAYOUT_CONTRACT_VERSION ||
    typeof sourceId !== "string" ||
    sourceId.trim() === "" ||
    sourceId !== sourceId.trim() ||
    typeof model !== "string" ||
    model.trim() === ""
  ) {
    throw new AffiliatePayoutContractError("required settlement fields are missing");
  }
  if (!isAffiliateBillingAttribution(attribution)) {
    throw new AffiliatePayoutContractError("affiliate attribution is malformed");
  }
  return {
    version: AFFILIATE_PAYOUT_CONTRACT_VERSION,
    sourceId,
    attribution,
    model,
  };
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      // Code-unit order, not localeCompare: ICU collation is locale-dependent and
      // ranks canonically equivalent distinct keys as equal, so identical payout
      // metadata could compare unequal across hosts and key insertion order.
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => [key, canonicalJson(nested)]),
  );
}

function metadataMatches(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function payableAffiliateMarkup(params: {
  actualTotalCost: number;
  collectedTotalCost: number;
  markupPercent: number;
}): Decimal {
  // Reservation amounts persist at six decimal places. Normalize to that
  // boundary before flooring the four-decimal payout so binary float noise
  // cannot turn an exact $1.2000 entitlement into $1.1999.
  const actual = new Decimal(params.actualTotalCost).toDecimalPlaces(6);
  const collected = new Decimal(params.collectedTotalCost).toDecimalPlaces(6);
  const markup = new Decimal(params.markupPercent);
  if (
    !actual.isFinite() ||
    actual.isNegative() ||
    !collected.isFinite() ||
    collected.isNegative() ||
    collected.greaterThan(actual) ||
    !markup.isFinite() ||
    markup.lte(0)
  ) {
    throw new AffiliatePayoutContractError("settlement amounts are outside their domain");
  }
  const preAffiliateCost = actual.div(markup.plus(1));
  const nominalMarkup = actual.minus(preAffiliateCost);
  const collectedMarkup = Decimal.max(0, collected.minus(preAffiliateCost));
  return Decimal.min(nominalMarkup, collectedMarkup).toDecimalPlaces(4, Decimal.ROUND_DOWN);
}

/**
 * Enqueue the collected portion of one affiliate markup inside the caller's
 * reservation-settlement transaction. A replay validates the immutable owner,
 * code, amount, and contract instead of silently accepting a collision.
 */
export async function enqueueCollectedAffiliatePayout(
  executor: SqlExecutor,
  params: {
    reservationMetadata: Record<string, unknown>;
    actualTotalCost: number;
    collectedTotalCost: number;
  },
): Promise<AffiliatePayoutOutboxSqlRow | null> {
  const contract = parseSettlementContract(params.reservationMetadata.affiliatePayout);
  if (!contract) return null;
  const amount = payableAffiliateMarkup({
    actualTotalCost: params.actualTotalCost,
    collectedTotalCost: params.collectedTotalCost,
    markupPercent: contract.attribution.markupPercent,
  });
  if (!amount.gt(0)) return null;

  const description = `Affiliate markup earnings from model: ${contract.model}`;
  const metadata = {
    affiliatePayoutVersion: AFFILIATE_PAYOUT_CONTRACT_VERSION,
    affiliateCodeId: contract.attribution.affiliateCodeId,
    affiliateCode: contract.attribution.affiliateCode,
    model: contract.model,
    actualTotalCost: new Decimal(params.actualTotalCost).toFixed(6),
    collectedTotalCost: new Decimal(params.collectedTotalCost).toFixed(6),
  };
  const metadataJson = JSON.stringify(metadata);
  const [row] = await sqlRows<AffiliatePayoutOutboxSqlRow>(
    executor,
    sql`
      WITH inserted AS (
        INSERT INTO affiliate_payout_outbox (
          source_id,
          affiliate_code_id,
          affiliate_user_id,
          amount,
          description,
          metadata
        )
        VALUES (
          ${contract.sourceId},
          ${contract.attribution.affiliateCodeId}::uuid,
          ${contract.attribution.affiliateUserId}::uuid,
          ${amount.toFixed(4)}::numeric,
          ${description},
          ${metadataJson}::jsonb
        )
        ON CONFLICT (source_id) DO NOTHING
        RETURNING *
      )
      SELECT * FROM inserted
      UNION ALL
      SELECT *
      FROM affiliate_payout_outbox
      WHERE source_id = ${contract.sourceId}
        AND NOT EXISTS (SELECT 1 FROM inserted)
      LIMIT 1
    `,
  );
  const rowMetadata = row ? parseMetadata(row.metadata) : {};
  if (
    !row ||
    row.affiliate_code_id !== contract.attribution.affiliateCodeId ||
    row.affiliate_user_id !== contract.attribution.affiliateUserId ||
    !new Decimal(row.amount).equals(amount) ||
    row.description !== description ||
    rowMetadata.affiliatePayoutVersion !== AFFILIATE_PAYOUT_CONTRACT_VERSION ||
    rowMetadata.affiliateCodeId !== contract.attribution.affiliateCodeId ||
    rowMetadata.affiliateCode !== contract.attribution.affiliateCode ||
    rowMetadata.model !== contract.model ||
    rowMetadata.actualTotalCost !== new Decimal(params.actualTotalCost).toFixed(6) ||
    rowMetadata.collectedTotalCost !== new Decimal(params.collectedTotalCost).toFixed(6)
  ) {
    throw new AffiliatePayoutReplayMismatchError(contract.sourceId);
  }
  return row;
}

async function validateProcessedLedger(
  row: AffiliatePayoutOutboxSqlRow,
  amount: Decimal,
  metadata: Record<string, unknown>,
): Promise<string> {
  if (!row.ledger_entry_id) {
    throw new AffiliatePayoutContractError("processed row has no ledger entry");
  }
  const [ledger] = await sqlRows<AffiliatePayoutLedgerSqlRow>(
    dbWrite,
    sql`
      SELECT
        id,
        user_id,
        entry_type,
        amount,
        earnings_source,
        source_id,
        description,
        metadata
      FROM redeemable_earnings_ledger
      WHERE id = ${row.ledger_entry_id}::uuid
      LIMIT 1
    `,
  );
  const normalizedSourceId = normalizeLedgerSourceId(row.source_id);
  const expectedMetadata = {
    ...metadata,
    ...(normalizedSourceId !== row.source_id ? { original_source_id: row.source_id } : {}),
  };
  if (
    !ledger ||
    ledger.user_id !== row.affiliate_user_id ||
    ledger.entry_type !== "earning" ||
    ledger.earnings_source !== "affiliate" ||
    ledger.source_id !== normalizedSourceId ||
    !new Decimal(ledger.amount).equals(amount) ||
    ledger.description !== row.description ||
    !metadataMatches(parseMetadata(ledger.metadata), expectedMetadata)
  ) {
    throw new AffiliatePayoutReplayMismatchError(row.source_id);
  }
  return ledger.id;
}

async function recordFailure(sourceId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await dbWrite.execute(sql`
    UPDATE affiliate_payout_outbox
    SET attempts = attempts + 1,
        last_error = ${message},
        next_attempt_at =
          NOW() + LEAST(3600, 30 * POWER(2, LEAST(attempts, 7))) * INTERVAL '1 second',
        updated_at = NOW()
    WHERE source_id = ${sourceId}
      AND processed_at IS NULL
  `);
}

/**
 * Project one durable payout into redeemable earnings. Lost acknowledgements
 * are harmless: the ledger dedupes globally by source id, then this retry marks
 * the same outbox row processed.
 */
export async function processAffiliatePayoutBySource(
  sourceId: string,
): Promise<{ processed: boolean; ledgerEntryId: string }> {
  if (sourceId.trim() === "") {
    throw new AffiliatePayoutContractError("source id must not be blank");
  }
  if (sourceId !== sourceId.trim()) {
    throw new AffiliatePayoutContractError("source id must not contain edge whitespace");
  }
  try {
    const [row] = await sqlRows<AffiliatePayoutOutboxSqlRow>(
      dbWrite,
      sql`
        SELECT *
        FROM affiliate_payout_outbox
        WHERE source_id = ${sourceId}
        LIMIT 1
      `,
    );
    if (!row) {
      throw new Error(`Affiliate payout outbox row not found: ${sourceId}`);
    }
    const metadata = parseMetadata(row.metadata);
    const amount = new Decimal(row.amount);
    if (!amount.isFinite() || !amount.gt(0)) {
      throw new AffiliatePayoutContractError("outbox amount is invalid");
    }
    if (row.processed_at !== null) {
      return {
        processed: false,
        ledgerEntryId: await validateProcessedLedger(row, amount, metadata),
      };
    }
    const earning = await redeemableEarningsService.addEarnings({
      userId: row.affiliate_user_id,
      amount: amount.toNumber(),
      source: "affiliate",
      sourceId: row.source_id,
      description: row.description,
      metadata,
      dedupeBySourceId: true,
    });
    if (!earning.success || !earning.ledgerEntryId) {
      throw new Error(earning.error ?? "Affiliate redeemable ledger rejected the payout");
    }

    const [completed] = await sqlRows<{ ledger_entry_id: string }>(
      dbWrite,
      sql`
        UPDATE affiliate_payout_outbox
        SET processed_at = NOW(),
            ledger_entry_id = ${earning.ledgerEntryId}::uuid,
            last_error = NULL,
            updated_at = NOW()
        WHERE source_id = ${sourceId}
          AND processed_at IS NULL
        RETURNING ledger_entry_id
      `,
    );
    if (completed) {
      return { processed: true, ledgerEntryId: completed.ledger_entry_id };
    }

    const [concurrentCompletion] = await sqlRows<{
      processed_at: Date | string | null;
      ledger_entry_id: string | null;
    }>(
      dbWrite,
      sql`
        SELECT processed_at, ledger_entry_id
        FROM affiliate_payout_outbox
        WHERE source_id = ${sourceId}
        LIMIT 1
      `,
    );
    if (
      !concurrentCompletion ||
      concurrentCompletion.processed_at === null ||
      concurrentCompletion.ledger_entry_id !== earning.ledgerEntryId
    ) {
      throw new AffiliatePayoutReplayMismatchError(sourceId);
    }
    return {
      processed: false,
      ledgerEntryId: concurrentCompletion.ledger_entry_id,
    };
  } catch (error) {
    // error-policy:J2 retain retry diagnostics without translating the payout
    // failure into a healthy billing result.
    try {
      await recordFailure(sourceId, error);
    } catch (recordError) {
      // error-policy:J2 both failures are needed to diagnose a stranded payout.
      throw new AggregateError(
        [error, recordError],
        `Affiliate payout and retry-state update failed for ${sourceId}`,
      );
    }
    throw error;
  }
}

export interface AffiliatePayoutDrainStats {
  scanned: number;
  processed: number;
  deduplicated: number;
  failed: number;
}

/** Drain due payout intents for the cron boundary. */
export async function drainAffiliatePayoutOutbox(limit = 100): Promise<AffiliatePayoutDrainStats> {
  if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) {
    throw new Error("Affiliate payout drain limit must be an integer between 1 and 1000");
  }
  const rows = await sqlRows<{ source_id: string }>(
    dbWrite,
    sql`
      SELECT source_id
      FROM affiliate_payout_outbox
      WHERE processed_at IS NULL
        AND next_attempt_at <= NOW()
      ORDER BY next_attempt_at ASC, created_at ASC
      LIMIT ${limit}
    `,
  );
  const stats: AffiliatePayoutDrainStats = {
    scanned: rows.length,
    processed: 0,
    deduplicated: 0,
    failed: 0,
  };
  for (const row of rows) {
    try {
      const result = await processAffiliatePayoutBySource(row.source_id);
      if (result.processed) stats.processed++;
      else stats.deduplicated++;
    } catch (error) {
      // error-policy:J1 the batch boundary reports a failed item explicitly and
      // leaves its durable row due for a later retry.
      stats.failed++;
      logger.error("[AffiliatePayout] durable payout attempt failed", {
        sourceId: row.source_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return stats;
}
