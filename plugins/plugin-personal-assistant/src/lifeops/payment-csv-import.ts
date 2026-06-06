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

function normalizeDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  // Try native parse first. Falls back to YYYY-MM-DD and MM/DD/YYYY.
  const native = Date.parse(trimmed);
  if (Number.isFinite(native)) {
    return new Date(native).toISOString();
  }
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return new Date(
      Date.UTC(
        Number(isoMatch[1]),
        Number(isoMatch[2]) - 1,
        Number(isoMatch[3]),
      ),
    ).toISOString();
  }
  const usMatch = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (usMatch) {
    const month = Number(usMatch[1]);
    const day = Number(usMatch[2]);
    const rawYear = Number(usMatch[3]);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    return new Date(Date.UTC(year, month - 1, day)).toISOString();
  }
  return null;
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
  const amountIndex = resolveColumnIndex(
    header,
    options.amountColumn,
    AMOUNT_COLUMN_HINTS,
  );
  const debitIndex = findColumn(header, DEBIT_COLUMN_HINTS);
  const creditIndex = findColumn(header, CREDIT_COLUMN_HINTS);
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
  if (dateIndex < 0 || merchantIndex < 0) {
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
