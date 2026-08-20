/**
 * Parses uploaded bank/card CSV exports into `LifeOpsPaymentTransaction` rows.
 *
 * An RFC 4180 splitter (`parseCsv`) feeds header-hint column detection that maps
 * varied bank column names onto date / merchant / amount, handling both
 * single-amount and separate debit/credit layouts and normalizing sign into a
 * payment direction. Backs the CSV payment-source import path in FinancesService.
 */

import { normalizeMerchant } from "./payment-recurrence.js";
import type {
  LifeOpsPaymentDirection,
  LifeOpsPaymentTransaction,
} from "./payment-types.js";

const DATE_COLUMN_HINTS = ["date", "posted", "posted date", "transaction date"];
// Only single-amount formats match here. Separate Debit/Credit columns are
// handled below via DEBIT_COLUMN_HINTS / CREDIT_COLUMN_HINTS so we don't
// collapse them into a single amount column.
const AMOUNT_COLUMN_HINTS = ["amount", "amount (usd)", "transaction amount"];
const DEBIT_COLUMN_HINTS = ["debit", "withdrawal", "amount debit"];
const CREDIT_COLUMN_HINTS = ["credit", "deposit", "amount credit"];
// Standalone direction words that make a single column one-sided. A header
// naming exactly one of these families is a one-sided column regardless of any
// surrounding value/descriptor tokens ("Debit Transaction Amount" is still a
// pure debit column).
const DEBIT_DIRECTION_WORDS = ["debit", "withdrawal"];
const CREDIT_DIRECTION_WORDS = ["credit", "deposit"];
// Narrowly reviewed compound descriptors where a direction word is part of a
// noun phrase, not an actual debit/credit direction. "Credit Card Amount" is a
// signed statement amount, not a credit-only column; the same holds for a debit
// card. These phrases are neutralized before direction words are counted so the
// residual header carries no false direction signal.
const NON_DIRECTIONAL_DESCRIPTORS = [
  // Order matters: consume the elliptical shared-card phrases before their
  // shorter suffixes, otherwise "Debit/Credit Card Amount" would retain the
  // leading "debit" and be misclassified as a debit-only column.
  /\b(?:debit\s*\/\s*credit|credit\s*\/\s*debit)\s+card\b/g,
  /\bcredit\s+card\b/g,
  /\bdebit\s+card\b/g,
] as const;
const MERCHANT_COLUMN_HINTS = [
  "merchant",
  "payee",
  "name",
  "description",
  "memo",
  "details",
];
const CATEGORY_COLUMN_HINTS = [
  "category",
  "transaction category",
  "plaid category",
];

/**
 * Minimal RFC 4180 CSV parser. Handles quoted fields with embedded commas
 * and escaped double quotes. Returns rows as string arrays.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = "";
  let inQuotes = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (char === ",") {
      current.push(field);
      field = "";
      index += 1;
      continue;
    }
    if (char === "\r") {
      // Ignore — the \n branch below does the newline handling.
      index += 1;
      continue;
    }
    if (char === "\n") {
      current.push(field);
      rows.push(current);
      current = [];
      field = "";
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }
  if (field.length > 0 || current.length > 0) {
    current.push(field);
    rows.push(current);
  }
  return rows.filter((row) => row.some((value) => value.trim().length > 0));
}

type DirectionColumnKind = "debit" | "credit" | "signed";

/**
 * Classifies a single physical column that matched a debit and/or credit hint.
 * A header naming exactly one direction family is a one-sided column whose every
 * row is that direction, and descriptive amount tokens do not change that:
 * "Amount Debit", "Withdrawal Amount", and "Debit Transaction Amount" are all
 * one-sided debit. Signedness is inferred only from an explicit shared-direction
 * header naming both families ("Debit/Credit", "Debit/Credit Amount") or from a
 * narrowly reviewed compound descriptor in which the direction word is part of a
 * noun ("Credit Card Amount"). Those descriptors are neutralized first, so a
 * header whose only direction word belonged to such a phrase carries no
 * surviving direction and is read as a signed amount whose sign chooses the
 * direction. Arbitrary extra words ("transaction") never imply signedness.
 */
function classifyDirectionColumn(headerCell: string): DirectionColumnKind {
  let normalized = headerCell.toLowerCase();
  for (const descriptor of NON_DIRECTIONAL_DESCRIPTORS) {
    normalized = normalized.replace(descriptor, " ");
  }
  const tokens = normalized.split(/[^a-z0-9]+/).filter((t) => t.length > 0);
  let debitWords = 0;
  let creditWords = 0;
  for (const token of tokens) {
    if (DEBIT_DIRECTION_WORDS.includes(token)) {
      debitWords += 1;
    } else if (CREDIT_DIRECTION_WORDS.includes(token)) {
      creditWords += 1;
    }
  }
  // Both families present, or no direction word survived descriptor removal:
  // the sign of each value chooses the direction.
  if (debitWords > 0 && creditWords > 0) {
    return "signed";
  }
  if (debitWords === 0 && creditWords === 0) {
    return "signed";
  }
  return debitWords > 0 ? "debit" : "credit";
}

function findColumn(
  header: readonly string[],
  hints: readonly string[],
): number {
  for (let index = 0; index < header.length; index += 1) {
    const normalized = header[index].trim().toLowerCase();
    if (hints.includes(normalized)) {
      return index;
    }
  }
  for (let index = 0; index < header.length; index += 1) {
    const normalized = header[index].trim().toLowerCase();
    for (const hint of hints) {
      if (normalized.includes(hint)) {
        return index;
      }
    }
  }
  return -1;
}

function parseAmount(
  row: readonly string[],
  amountIndex: number,
  debitIndex: number,
  creditIndex: number,
): { amountUsd: number; direction: LifeOpsPaymentDirection } | null {
  const readNumber = (raw: string | undefined): number | null => {
    if (raw === undefined) {
      return null;
    }
    const cleaned = raw.replace(/[$,]/g, "").trim();
    if (!cleaned) {
      return null;
    }
    // Handle "(12.34)" accounting negatives.
    const negative = /^\(.+\)$/.test(cleaned);
    const value = Number(cleaned.replace(/[()]/g, ""));
    if (!Number.isFinite(value)) {
      return null;
    }
    return negative ? -value : value;
  };

  if (amountIndex >= 0) {
    const amount = readNumber(row[amountIndex]);
    if (amount === null) {
      return null;
    }
    return {
      amountUsd: Math.abs(amount),
      direction: amount < 0 ? "debit" : "credit",
    };
  }
  if (debitIndex >= 0) {
    const debit = readNumber(row[debitIndex]);
    if (debit !== null && debit !== 0) {
      return { amountUsd: Math.abs(debit), direction: "debit" };
    }
  }
  if (creditIndex >= 0) {
    const credit = readNumber(row[creditIndex]);
    if (credit !== null && credit !== 0) {
      return { amountUsd: Math.abs(credit), direction: "credit" };
    }
  }
  return null;
}

// Date.UTC silently rolls an out-of-range month/day into a different date
// (month 13 becomes January of next year, Feb 31 becomes Mar 2/3) instead of
// signaling an error. Round-tripping the constructed date's calendar fields
// catches that instead of trusting Date.UTC's return value.
function utcMidnightIsoOrNull(
  year: number,
  month1based: number,
  day: number,
): string | null {
  // Construct from an epoch date and set the full year explicitly: Date.UTC
  // remaps years 0..99 to 1900..1999, which would reject otherwise-valid
  // four-digit ISO years such as 0000 and 0099 during the round-trip check.
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month1based - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month1based - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString();
}

function normalizeDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  // Date-only values must map to the same UTC instant on every machine:
  // buildTransactionId hashes postedAt, so a timezone-dependent parse would
  // mint different ids for the same row and double-count re-imports. The
  // explicit UTC-based branches therefore run BEFORE the native Date.parse
  // fallback, which is reserved for strings carrying a time component.
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return utcMidnightIsoOrNull(
      Number(isoMatch[1]),
      Number(isoMatch[2]),
      Number(isoMatch[3]),
    );
  }
  const usMatch = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (usMatch) {
    const month = Number(usMatch[1]);
    const day = Number(usMatch[2]);
    const rawYear = Number(usMatch[3]);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    return utcMidnightIsoOrNull(year, month, day);
  }
  const native = Date.parse(trimmed);
  if (!Number.isFinite(native)) {
    return null;
  }
  // Strings with a time-of-day or an explicit timezone keep native semantics.
  // The timezone guard also covers date-only RFC spellings such as
  // "02 Jan 2024 GMT": rebasing that already-UTC instant through local calendar
  // fields would move it to the prior day west of UTC. Remaining date-only
  // spellings such as "Jan 2, 2024" parse as local midnight, so rebase their
  // local calendar date onto UTC midnight for cross-machine determinism.
  const hasExplicitTimezone =
    /(?:\b(?:UTC|GMT|[ECMP][SD]T)|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  if (/\d:\d/.test(trimmed) || hasExplicitTimezone) {
    return new Date(native).toISOString();
  }
  const local = new Date(native);
  return new Date(
    Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()),
  ).toISOString();
}

export interface ParsedCsvTransaction
  extends Pick<
    LifeOpsPaymentTransaction,
    | "postedAt"
    | "amountUsd"
    | "direction"
    | "merchantRaw"
    | "merchantNormalized"
    | "description"
    | "category"
    | "currency"
    | "externalId"
  > {
  rowIndex: number;
}

export interface ParseCsvOptions {
  dateColumn?: string;
  amountColumn?: string;
  merchantColumn?: string;
  descriptionColumn?: string;
  categoryColumn?: string;
}

export interface ParseCsvResult {
  transactions: ParsedCsvTransaction[];
  rowsRead: number;
  errors: string[];
}

function resolveColumnIndex(
  header: readonly string[],
  hint: string | undefined,
  fallbackHints: readonly string[],
): number {
  if (hint) {
    const explicitIndex = header.findIndex(
      (value) => value.trim().toLowerCase() === hint.trim().toLowerCase(),
    );
    if (explicitIndex >= 0) {
      return explicitIndex;
    }
  }
  return findColumn(header, fallbackHints);
}

export function parseTransactionsCsv(
  csvText: string,
  options: ParseCsvOptions = {},
): ParseCsvResult {
  const rows = parseCsv(csvText);
  if (rows.length < 2) {
    return {
      transactions: [],
      rowsRead: Math.max(0, rows.length - 1),
      errors: ["CSV has no data rows."],
    };
  }
  const header = rows[0].map((value) => value.trim());
  const dateIndex = resolveColumnIndex(
    header,
    options.dateColumn,
    DATE_COLUMN_HINTS,
  );
  let amountIndex = resolveColumnIndex(
    header,
    options.amountColumn,
    AMOUNT_COLUMN_HINTS,
  );
  let debitIndex = findColumn(header, DEBIT_COLUMN_HINTS);
  let creditIndex = findColumn(header, CREDIT_COLUMN_HINTS);
  const amountExplicit =
    options.amountColumn !== undefined &&
    amountIndex >= 0 &&
    header[amountIndex]?.trim().toLowerCase() ===
      options.amountColumn.trim().toLowerCase();
  // Two DISTINCT physical columns are a genuine separate debit/credit layout.
  // Anything else is at most one matched direction column, resolved below.
  const hasSeparateDebitCredit =
    debitIndex >= 0 && creditIndex >= 0 && debitIndex !== creditIndex;
  if (hasSeparateDebitCredit) {
    // The AMOUNT substring fallback in findColumn also matches a separate
    // "Amount Debit"/"Amount Credit" bank header (both contain "amount"). Left
    // alone, the single-amount branch reads the debit column as a signed amount
    // — flipping debit rows to credit and dropping credit-only rows. Drop an
    // inferred amount index pointing at either directional column so the
    // separate-column path runs. An explicit options.amountColumn match is
    // honored and never collapsed.
    if (
      !amountExplicit &&
      amountIndex >= 0 &&
      (amountIndex === debitIndex || amountIndex === creditIndex)
    ) {
      amountIndex = -1;
    }
  } else {
    // At most one physical column matched a direction hint. It is either a
    // one-sided directional column (every row is that direction) or a signed
    // amount column whose sign chooses direction. classifyDirectionColumn tells
    // them apart: "Amount Debit"/"Withdrawal Amount" are one-sided debit while
    // "Debit/Credit"/"Credit Card Amount" are signed. An explicit amountColumn
    // pointed at that column keeps the signed reading the user asked for.
    const directionIndex = debitIndex >= 0 ? debitIndex : creditIndex;
    if (directionIndex >= 0) {
      const kind =
        amountExplicit && amountIndex === directionIndex
          ? "signed"
          : classifyDirectionColumn(header[directionIndex]);
      if (kind === "signed") {
        // Promote the shared column to the signed amount path and clear the
        // direction indices so parseAmount reads the sign instead of treating
        // every row as one direction.
        if (amountIndex < 0) {
          amountIndex = directionIndex;
        }
        debitIndex = -1;
        creditIndex = -1;
      } else if (kind === "debit") {
        debitIndex = directionIndex;
        creditIndex = -1;
        // Drop a coincident amount index so the debit-first branch runs and a
        // positive value stays a debit instead of flipping to credit.
        if (amountIndex === directionIndex) {
          amountIndex = -1;
        }
      } else {
        creditIndex = directionIndex;
        debitIndex = -1;
        if (amountIndex === directionIndex) {
          amountIndex = -1;
        }
      }
    }
  }
  const merchantIndex = resolveColumnIndex(
    header,
    options.merchantColumn,
    MERCHANT_COLUMN_HINTS,
  );
  const descriptionIndex = resolveColumnIndex(
    header,
    options.descriptionColumn,
    ["description", "memo", "details"],
  );
  const categoryIndex = resolveColumnIndex(
    header,
    options.categoryColumn,
    CATEGORY_COLUMN_HINTS,
  );

  const errors: string[] = [];
  if (dateIndex < 0) {
    errors.push("Could not find a date column in the CSV header.");
  }
  if (amountIndex < 0 && debitIndex < 0 && creditIndex < 0) {
    errors.push(
      "Could not find an amount/debit/credit column in the CSV header.",
    );
  }
  if (merchantIndex < 0) {
    errors.push("Could not find a merchant / payee / description column.");
  }

  const transactions: ParsedCsvTransaction[] = [];
  const hasAmountColumn =
    amountIndex >= 0 || debitIndex >= 0 || creditIndex >= 0;
  if (dateIndex < 0 || merchantIndex < 0 || !hasAmountColumn) {
    return { transactions, rowsRead: rows.length - 1, errors };
  }

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row.length === 0) {
      continue;
    }
    const postedAt = normalizeDate(row[dateIndex] ?? "");
    if (!postedAt) {
      errors.push(
        `Row ${rowIndex + 1}: unparseable date "${row[dateIndex] ?? ""}".`,
      );
      continue;
    }
    const amount = parseAmount(row, amountIndex, debitIndex, creditIndex);
    if (!amount) {
      errors.push(`Row ${rowIndex + 1}: unparseable amount.`);
      continue;
    }
    const merchantRaw = (row[merchantIndex] ?? "").trim();
    if (!merchantRaw) {
      errors.push(`Row ${rowIndex + 1}: empty merchant.`);
      continue;
    }
    const description =
      descriptionIndex >= 0 ? (row[descriptionIndex] ?? "").trim() : "";
    const category =
      categoryIndex >= 0 ? (row[categoryIndex] ?? "").trim() : "";
    transactions.push({
      postedAt,
      amountUsd: amount.amountUsd,
      direction: amount.direction,
      merchantRaw,
      merchantNormalized: normalizeMerchant(merchantRaw),
      description: description.length > 0 ? description : null,
      category: category.length > 0 ? category : null,
      currency: "USD",
      externalId: null,
      rowIndex,
    });
  }

  return {
    transactions,
    rowsRead: rows.length - 1,
    errors,
  };
}
