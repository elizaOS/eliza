import type {
  LifeOpsPaymentTransaction,
  LifeOpsRecurringCadence,
  LifeOpsRecurringCharge,
} from "./payment-types.js";

const MIN_RECURRENCE_OCCURRENCES = 2;
const MS_PER_DAY = 86_400_000;

interface IntervalMatch {
  cadence: LifeOpsRecurringCadence;
  avgIntervalDays: number;
  stddevDays: number;
}

/**
 * Normalize a merchant string for grouping. Strips trailing location/ref
 * suffixes, collapses whitespace, removes non-alpha noise, lowercases.
 *
 * Bank feeds commonly produce variants like:
 *   - "NETFLIX.COM 866-579-7172 CA"
 *   - "NETFLIX.COM   #8432"
 *   - "Netflix Monthly 11.99"
 * We want all three to collapse to "netflix".
 */
export function normalizeMerchant(raw: string): string {
  const trimmed = raw
    .toLowerCase()
    // Strip common URL TLDs: ".com", ".co", ".io", ".net", ".org"
    .replace(/\.(com|co|io|net|org|tv|app)\b/g, " ")
    // Drop phone numbers
    .replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, " ")
    // Drop reference-style "#12345" or "POS 12345"
    .replace(/#\s*\d+/g, " ")
    .replace(/\bpos\b/g, " ")
    // Drop dollar-ish amounts that sometimes leak into descriptions
    .replace(/\$?\d+(?:\.\d{2})?/g, " ")
    // Drop state codes and common noise
    .replace(/\b(ca|ny|tx|fl|wa|il|us|usa)\b/g, " ")
    // Collapse non-alpha to space
    .replace(/[^a-z]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Keep first 3 tokens max — that's almost always the brand identity.
  return trimmed.split(" ").slice(0, 3).join(" ");
}

function humanizeMerchant(normalized: string): string {
  return normalized
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function daysBetween(a: string, b: string): number {
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs) || !Number.isFinite(bMs)) {
    return Number.NaN;
  }
  return Math.abs(bMs - aMs) / MS_PER_DAY;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total / values.length;
}

function stddev(values: readonly number[], avg: number): number {
  if (values.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const value of values) {
    const diff = value - avg;
    sum += diff * diff;
  }
  return Math.sqrt(sum / values.length);
}

function classifyCadence(avgIntervalDays: number): LifeOpsRecurringCadence {
  if (avgIntervalDays >= 5 && avgIntervalDays <= 9) return "weekly";
  if (avgIntervalDays >= 12 && avgIntervalDays <= 16) return "biweekly";
  if (avgIntervalDays >= 25 && avgIntervalDays <= 35) return "monthly";
  if (avgIntervalDays >= 85 && avgIntervalDays <= 95) return "quarterly";
  if (avgIntervalDays >= 350 && avgIntervalDays <= 380) return "annual";
  return "irregular";
}

function cadenceMultiplier(cadence: LifeOpsRecurringCadence): number {
  switch (cadence) {
    case "weekly":
      return 52;
    case "biweekly":
      return 26;
    case "monthly":
      return 12;
    case "quarterly":
      return 4;
    case "annual":
      return 1;
    case "irregular":
      return 0;
  }
}

function detectInterval(
  sortedPostedAts: readonly string[],
): IntervalMatch | null {
  if (sortedPostedAts.length < MIN_RECURRENCE_OCCURRENCES) {
    return null;
  }
  const intervals: number[] = [];
  for (let index = 1; index < sortedPostedAts.length; index += 1) {
    const days = daysBetween(
      sortedPostedAts[index - 1],
      sortedPostedAts[index],
    );
    if (Number.isFinite(days)) {
      intervals.push(days);
    }
  }
  if (intervals.length === 0) {
    return null;
  }
  const avg = mean(intervals);
  const dev = stddev(intervals, avg);
  const cadence = classifyCadence(avg);
  return { cadence, avgIntervalDays: avg, stddevDays: dev };
}

function amountSimilarity(amounts: readonly number[]): number {
  if (amounts.length === 0) {
    return 0;
  }
  const avg = mean(amounts);
  if (avg === 0) {
    return 0;
  }
  const dev = stddev(amounts, avg);
  const ratio = dev / Math.abs(avg);
  // Perfect similarity (0 dev) → 1. Ratio of 0.25 → ~0.5. Ratio ≥ 1 → 0.
  return Math.max(0, Math.min(1, 1 - ratio));
}

function confidenceScore(args: {
  occurrenceCount: number;
  cadence: LifeOpsRecurringCadence;
  intervalStddev: number;
  avgIntervalDays: number;
  amountSimilarity: number;
}): number {
  const cadenceBoost = args.cadence === "irregular" ? 0.2 : 0.55;
  const occurrenceBoost = Math.min(0.25, args.occurrenceCount * 0.04);
  const intervalConsistency =
    args.avgIntervalDays > 0
      ? Math.max(0, 1 - args.intervalStddev / args.avgIntervalDays)
      : 0;
  const intervalBoost = intervalConsistency * 0.1;
  const amountBoost = args.amountSimilarity * 0.1;
  return Math.min(
    0.99,
    cadenceBoost + occurrenceBoost + intervalBoost + amountBoost,
  );
}

function addDaysIso(value: string, days: number): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    return value;
  }
  return new Date(ms + days * MS_PER_DAY).toISOString();
}

export function detectRecurringCharges(
  transactions: readonly LifeOpsPaymentTransaction[],
): LifeOpsRecurringCharge[] {
  const debits = transactions.filter(
    (transaction) => transaction.direction === "debit",
  );
  const groups = new Map<string, LifeOpsPaymentTransaction[]>();
  for (const transaction of debits) {
    const existing = groups.get(transaction.merchantNormalized);
    if (existing) {
      existing.push(transaction);
    } else {
      groups.set(transaction.merchantNormalized, [transaction]);
    }
  }

  const charges: LifeOpsRecurringCharge[] = [];
  for (const [merchant, group] of groups) {
    if (!merchant || group.length < MIN_RECURRENCE_OCCURRENCES) {
      continue;
    }
    const sorted = [...group].sort((a, b) =>
      a.postedAt.localeCompare(b.postedAt),
    );
    const postedAts = sorted.map((transaction) => transaction.postedAt);
    const interval = detectInterval(postedAts);
    if (!interval) {
      continue;
    }
    const amounts = sorted.map((transaction) =>
      Math.abs(transaction.amountUsd),
    );
    const avgAmount = mean(amounts);
    const lastAmount = amounts[amounts.length - 1] ?? 0;
    const similarity = amountSimilarity(amounts);
    if (interval.cadence === "irregular" && similarity < 0.7) {
      // Skip non-recurring merchants that only happen to hit multiple times
      // with different amounts (e.g. Amazon purchases).
      continue;
    }
    const multiplier = cadenceMultiplier(interval.cadence);
    const confidence = confidenceScore({
      occurrenceCount: group.length,
      cadence: interval.cadence,
      intervalStddev: interval.stddevDays,
      avgIntervalDays: interval.avgIntervalDays,
      amountSimilarity: similarity,
    });
    const latestSeenAt = postedAts[postedAts.length - 1];
    const nextExpectedAt =
      interval.cadence === "irregular"
        ? null
        : addDaysIso(latestSeenAt, interval.avgIntervalDays);
    const sourceIds = Array.from(
      new Set(sorted.map((transaction) => transaction.sourceId)),
    );
    const sampleTransactionIds = sorted
      .slice(-5)
      .map((transaction) => transaction.id);
    const category =
      sorted.find((transaction) => transaction.category)?.category ?? null;
    const display =
      sorted[sorted.length - 1]?.merchantRaw?.trim() ||
      humanizeMerchant(merchant);
    charges.push({
      merchantNormalized: merchant,
      merchantDisplay: display,
      cadence: interval.cadence,
      averageAmountUsd: Number(avgAmount.toFixed(2)),
      lastAmountUsd: Number(lastAmount.toFixed(2)),
      annualizedCostUsd: Number((avgAmount * multiplier).toFixed(2)),
      occurrenceCount: group.length,
      firstSeenAt: postedAts[0],
      latestSeenAt,
      nextExpectedAt,
      sourceIds,
      sampleTransactionIds,
      confidence,
      category,
    });
  }
  charges.sort((a, b) => b.annualizedCostUsd - a.annualizedCostUsd);
  return charges;
}
