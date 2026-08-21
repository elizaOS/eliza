/**
 * Scans production Cloud TypeScript for credit debit, reservation, raw balance
 * mutation, and ledger-write signals used by the subscription funding ratchet.
 */

import { readdirSync, readFileSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import type { SubscriptionDebitSignal } from "../src/lib/services/subscription-funding-policy";

export const CLOUD_ROOT = resolve(import.meta.dirname, "../..");

const SIGNAL_PATTERNS: Readonly<Record<SubscriptionDebitSignal, RegExp>> = {
  credit_service_deduct: /\bcreditsService\.deductCredits\s*\(/g,
  credit_service_reserve: /\bcreditsService\.reserve\s*\(/g,
  credit_service_reserve_and_deduct: /\bcreditsService\.reserveAndDeductCredits\s*\(/g,
  credit_transaction_repository_create: /\bcreditTransactionsRepository\.create\s*\(/g,
  debit_ledger_literal: /\btype\s*:\s*["']debit["']/g,
  organization_repository_deduct: /\borganizationsRepository\.deductCreditsWithTransaction\s*\(/g,
  raw_credit_balance_decrement:
    /credit_balance\s*(?:=|:\s*sql`)\s*(?:(?![;`]).|\r?\n){0,420}?\s-\s/g,
  raw_credit_transaction_sql_insert: /\bINSERT\s+INTO\s+"?credit_transactions"?/gi,
  raw_credit_transaction_insert: /\.insert\s*\(\s*creditTransactions\s*\)/g,
};

function isProductionTypeScript(relativePath: string): boolean {
  const segments = relativePath.split("/");
  const fileName = segments.at(-1) ?? "";
  return (
    extname(fileName) === ".ts" &&
    !fileName.endsWith(".test.ts") &&
    !fileName.endsWith(".spec.ts") &&
    !segments.includes("__tests__") &&
    !segments.includes("test") &&
    !segments.includes("migrations") &&
    !segments.includes("scripts")
  );
}

function listProductionTypeScript(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listProductionTypeScript(absolutePath));
    } else {
      const relativePath = relative(CLOUD_ROOT, absolutePath).split(sep).join("/");
      if (isProductionTypeScript(relativePath)) files.push(relativePath);
    }
  }
  return files.sort();
}

export function scanSubscriptionDebitSignals(
  source: string,
): Partial<Record<SubscriptionDebitSignal, number>> {
  const signals: Partial<Record<SubscriptionDebitSignal, number>> = {};
  for (const [signal, pattern] of Object.entries(SIGNAL_PATTERNS) as [
    SubscriptionDebitSignal,
    RegExp,
  ][]) {
    pattern.lastIndex = 0;
    const count = Array.from(source.matchAll(pattern)).length;
    if (count > 0) signals[signal] = count;
  }
  return signals;
}

export function scanProductionSubscriptionDebitInventory(): Record<
  string,
  Partial<Record<SubscriptionDebitSignal, number>>
> {
  return Object.fromEntries(
    listProductionTypeScript(CLOUD_ROOT)
      .map((relativePath) => [
        relativePath,
        scanSubscriptionDebitSignals(readFileSync(resolve(CLOUD_ROOT, relativePath), "utf8")),
      ])
      .filter(([, signals]) => Object.keys(signals).length > 0),
  );
}

if (import.meta.main) {
  process.stdout.write(`${JSON.stringify(scanProductionSubscriptionDebitInventory(), null, 2)}\n`);
}
