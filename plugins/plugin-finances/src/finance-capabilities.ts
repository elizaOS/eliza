/**
 * Provider-neutral finance capability layer: normalized balance, budget,
 * subscription, and anomaly calculations plus the freshness/calculation
 * metadata and internal-write receipts the OWNER_FINANCES action attaches to
 * every capability response.
 *
 * Everything here is a deterministic pure function over already-loaded rows —
 * no I/O, no provider SDK types. The action layer (`src/actions/finances.ts`)
 * loads rows through `FinancesService` and passes an explicit `now`, so the
 * same inputs always produce the same outputs in tests and at runtime. All
 * capabilities are read/derive only: nothing in this module initiates a
 * payment, transfer, or trade, and receipts describe only writes to the
 * plugin's own `app_finances` tables. Receipts and metadata never carry
 * tokens, account numbers, or other credentials.
 */

import { randomUUID } from "node:crypto";
import type {
  LifeOpsPaymentSource,
  LifeOpsPaymentTransaction,
  LifeOpsRecurringCharge,
} from "./payment-types.ts";

/** Discriminates how a capability value was produced. */
export type FinanceCalculationMethod =
  | "derived_from_transactions"
  | "provider_reported"
  | "user_supplied_input";

/**
 * Freshness and provenance metadata attached to every capability response.
 * `latestDataAt` is the newest posting timestamp among the rows the
 * calculation actually consumed (null when the input set is empty), which is
 * distinct from `generatedAt` (when the calculation ran).
 */
export interface FinanceCapabilityMeta {
  capability: string;
  provider: "plugin-finances";
  generatedAt: string;
  freshness: {
    latestDataAt: string | null;
    transactionCount: number;
    sourceCount: number;
  };
  calculation: {
    method: FinanceCalculationMethod;
    windowDays: number | null;
    notes: readonly string[];
  };
}

/**
 * Receipt for a successful internal write (add/remove source, CSV import).
 * Describes what changed in `app_finances` without exposing row payloads or
 * credentials, so the planner and audit surfaces can cite the mutation.
 */
export interface FinanceWriteReceipt {
  receiptId: string;
  capability: string;
  operation: "create" | "delete" | "import";
  entityType: "payment_source" | "transactions";
  entityId: string;
  occurredAt: string;
  outcome: "applied";
  counts: { inserted: number; skipped: number; errors: number } | null;
}

/** Builds a write receipt for a completed internal mutation. */
export function buildWriteReceipt(args: {
  capability: string;
  operation: FinanceWriteReceipt["operation"];
  entityType: FinanceWriteReceipt["entityType"];
  entityId: string;
  now: Date;
  counts?: { inserted: number; skipped: number; errors: number };
}): FinanceWriteReceipt {
  return {
    receiptId: randomUUID(),
    capability: args.capability,
    operation: args.operation,
    entityType: args.entityType,
    entityId: args.entityId,
    occurredAt: args.now.toISOString(),
    outcome: "applied",
    counts: args.counts ?? null,
  };
}

function latestPostedAt(
  transactions: readonly LifeOpsPaymentTransaction[],
): string | null {
  let latest: string | null = null;
  for (const tx of transactions) {
    if (latest === null || tx.postedAt > latest) {
      latest = tx.postedAt;
    }
  }
  return latest;
}

/** Builds the shared freshness/calculation metadata for one capability run. */
export function buildCapabilityMeta(args: {
  capability: string;
  now: Date;
  transactions: readonly LifeOpsPaymentTransaction[];
  sourceCount: number;
  method: FinanceCalculationMethod;
  windowDays?: number | null;
  notes?: readonly string[];
}): FinanceCapabilityMeta {
  return {
    capability: args.capability,
    provider: "plugin-finances",
    generatedAt: args.now.toISOString(),
    freshness: {
      latestDataAt: latestPostedAt(args.transactions),
      transactionCount: args.transactions.length,
      sourceCount: args.sourceCount,
    },
    calculation: {
      method: args.method,
      windowDays: args.windowDays ?? null,
      notes: args.notes ?? [],
    },
  };
}

/** True when the transaction is flagged pending by its originating provider. */
export function isPendingTransaction(tx: LifeOpsPaymentTransaction): boolean {
  return tx.metadata.pending === true;
}

/**
 * Net derived balance for one payment source. Balances are derived from the
 * transaction ledger (credits minus debits), not reported by an institution,
 * and the metadata says so; pending amounts are tracked separately and never
 * folded into the settled figure. `currencies` lists every original currency
 * observed so multi-currency sources are visible rather than silently merged.
 */
export interface FinanceSourceBalance {
  sourceId: string;
  label: string;
  kind: LifeOpsPaymentSource["kind"];
  netFlowUsd: number;
  settledDebitsUsd: number;
  settledCreditsUsd: number;
  pendingCount: number;
  pendingDebitsUsd: number;
  settledTransactionCount: number;
  currencies: readonly string[];
  latestActivityAt: string | null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Derives per-source balances from the transaction ledger. */
export function computeSourceBalances(
  sources: readonly LifeOpsPaymentSource[],
  transactions: readonly LifeOpsPaymentTransaction[],
): FinanceSourceBalance[] {
  const bySource = new Map<string, LifeOpsPaymentTransaction[]>();
  for (const tx of transactions) {
    const list = bySource.get(tx.sourceId);
    if (list) {
      list.push(tx);
    } else {
      bySource.set(tx.sourceId, [tx]);
    }
  }
  return sources.map((source) => {
    const rows = bySource.get(source.id) ?? [];
    let debits = 0;
    let credits = 0;
    let pendingCount = 0;
    let pendingDebits = 0;
    let settledCount = 0;
    const currencies = new Set<string>();
    for (const tx of rows) {
      currencies.add(tx.currency);
      if (isPendingTransaction(tx)) {
        pendingCount += 1;
        if (tx.direction === "debit") {
          pendingDebits += tx.amountUsd;
        }
        continue;
      }
      settledCount += 1;
      if (tx.direction === "debit") {
        debits += tx.amountUsd;
      } else {
        credits += tx.amountUsd;
      }
    }
    return {
      sourceId: source.id,
      label: source.label,
      kind: source.kind,
      netFlowUsd: round2(credits - debits),
      settledDebitsUsd: round2(debits),
      settledCreditsUsd: round2(credits),
      pendingCount,
      pendingDebitsUsd: round2(pendingDebits),
      settledTransactionCount: settledCount,
      currencies: Array.from(currencies).sort(),
      latestActivityAt: latestPostedAt(rows),
    };
  });
}

/**
 * Budget evaluation for a user-supplied budget over a rolling window. The
 * budget amount itself is an input, never inferred, so the status carries
 * `user_supplied_input` calculation metadata.
 */
export interface FinanceBudgetStatus {
  budgetUsd: number;
  windowDays: number;
  spentUsd: number;
  remainingUsd: number;
  utilization: number;
  status: "under_budget" | "near_limit" | "over_budget";
  settledTransactionCount: number;
  pendingExcludedCount: number;
}

/** Compares settled debit spend inside the window against a supplied budget. */
export function computeBudgetStatus(args: {
  transactions: readonly LifeOpsPaymentTransaction[];
  budgetUsd: number;
  windowDays: number;
  now: Date;
}): FinanceBudgetStatus {
  const windowStart = new Date(
    args.now.getTime() - args.windowDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  let spent = 0;
  let settledCount = 0;
  let pendingExcluded = 0;
  for (const tx of args.transactions) {
    if (tx.postedAt < windowStart || tx.direction !== "debit") {
      continue;
    }
    if (isPendingTransaction(tx)) {
      pendingExcluded += 1;
      continue;
    }
    spent += tx.amountUsd;
    settledCount += 1;
  }
  const spentRounded = round2(spent);
  const utilization =
    args.budgetUsd > 0 ? round2(spentRounded / args.budgetUsd) : 0;
  return {
    budgetUsd: args.budgetUsd,
    windowDays: args.windowDays,
    spentUsd: spentRounded,
    remainingUsd: round2(args.budgetUsd - spentRounded),
    utilization,
    status:
      spentRounded > args.budgetUsd
        ? "over_budget"
        : utilization >= 0.9
          ? "near_limit"
          : "under_budget",
    settledTransactionCount: settledCount,
    pendingExcludedCount: pendingExcluded,
  };
}

/** One detected irregularity in the transaction ledger. */
export interface FinanceAnomaly {
  kind: "possible_duplicate_charge" | "amount_spike";
  merchantNormalized: string;
  merchantDisplay: string;
  transactionIds: readonly string[];
  amountUsd: number;
  detail: string;
}

const DUPLICATE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const SPIKE_MULTIPLIER = 2.5;
const SPIKE_MIN_HISTORY = 3;
const SPIKE_MIN_DELTA_USD = 20;

/**
 * Flags possible duplicate charges (same source, merchant, and amount posted
 * within 3 days under distinct ids) and amount spikes (a debit at least 2.5x
 * a merchant's average across 3+ prior settled debits, and at least $20 over
 * it). Pending rows never generate anomalies: providers routinely post a
 * pending row and its settled duplicate. Merchant comparison uses the
 * normalized name so adversarial raw strings ("NETFLlX.COM*8873") group with
 * their real merchant instead of dodging detection.
 */
export function detectAnomalies(
  transactions: readonly LifeOpsPaymentTransaction[],
): FinanceAnomaly[] {
  const settledDebits = transactions
    .filter((tx) => tx.direction === "debit" && !isPendingTransaction(tx))
    .sort((a, b) => a.postedAt.localeCompare(b.postedAt));

  const anomalies: FinanceAnomaly[] = [];
  const reportedDuplicatePairs = new Set<string>();

  for (let i = 0; i < settledDebits.length; i += 1) {
    const tx = settledDebits[i];
    for (let j = i + 1; j < settledDebits.length; j += 1) {
      const other = settledDebits[j];
      const gap =
        new Date(other.postedAt).getTime() - new Date(tx.postedAt).getTime();
      if (gap > DUPLICATE_WINDOW_MS) {
        break;
      }
      if (
        other.sourceId === tx.sourceId &&
        other.merchantNormalized === tx.merchantNormalized &&
        other.amountUsd === tx.amountUsd &&
        other.id !== tx.id
      ) {
        const pairKey = [tx.id, other.id].sort().join(":");
        if (!reportedDuplicatePairs.has(pairKey)) {
          reportedDuplicatePairs.add(pairKey);
          anomalies.push({
            kind: "possible_duplicate_charge",
            merchantNormalized: tx.merchantNormalized,
            merchantDisplay: tx.merchantRaw,
            transactionIds: [tx.id, other.id],
            amountUsd: tx.amountUsd,
            detail: `Two $${tx.amountUsd.toFixed(2)} charges from the same merchant and source within 3 days.`,
          });
        }
      }
    }
  }

  const history = new Map<string, number[]>();
  for (const tx of settledDebits) {
    const prior = history.get(tx.merchantNormalized) ?? [];
    if (prior.length >= SPIKE_MIN_HISTORY) {
      const average = prior.reduce((sum, v) => sum + v, 0) / prior.length;
      if (
        tx.amountUsd >= average * SPIKE_MULTIPLIER &&
        tx.amountUsd - average >= SPIKE_MIN_DELTA_USD
      ) {
        anomalies.push({
          kind: "amount_spike",
          merchantNormalized: tx.merchantNormalized,
          merchantDisplay: tx.merchantRaw,
          transactionIds: [tx.id],
          amountUsd: tx.amountUsd,
          detail: `$${tx.amountUsd.toFixed(2)} is ${(tx.amountUsd / average).toFixed(1)}x this merchant's $${average.toFixed(2)} average across ${prior.length} prior charges.`,
        });
      }
    }
    prior.push(tx.amountUsd);
    history.set(tx.merchantNormalized, prior);
  }

  return anomalies;
}

/**
 * Provider-neutral subscription record projected from recurring-charge
 * detection: regular-cadence recurring debits with detection confidence, kept
 * distinct from the write-side subscription audit/cancellation tables.
 */
export interface FinanceSubscriptionRecord {
  merchantNormalized: string;
  merchantDisplay: string;
  cadence: LifeOpsRecurringCharge["cadence"];
  averageAmountUsd: number;
  annualizedCostUsd: number;
  nextExpectedAt: string | null;
  latestSeenAt: string;
  confidence: number;
  sourceIds: readonly string[];
}

const SUBSCRIPTION_MIN_CONFIDENCE = 0.5;

/** Projects regular-cadence recurring charges into subscription records. */
export function normalizeSubscriptions(
  charges: readonly LifeOpsRecurringCharge[],
): FinanceSubscriptionRecord[] {
  return charges
    .filter(
      (charge) =>
        charge.cadence !== "irregular" &&
        charge.confidence >= SUBSCRIPTION_MIN_CONFIDENCE,
    )
    .map((charge) => ({
      merchantNormalized: charge.merchantNormalized,
      merchantDisplay: charge.merchantDisplay,
      cadence: charge.cadence,
      averageAmountUsd: charge.averageAmountUsd,
      annualizedCostUsd: charge.annualizedCostUsd,
      nextExpectedAt: charge.nextExpectedAt,
      latestSeenAt: charge.latestSeenAt,
      confidence: charge.confidence,
      sourceIds: charge.sourceIds,
    }))
    .sort((a, b) => b.annualizedCostUsd - a.annualizedCostUsd);
}
