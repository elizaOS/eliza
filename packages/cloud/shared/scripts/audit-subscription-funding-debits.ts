/**
 * Scans production Cloud TypeScript for credit debit, reservation, raw balance
 * mutation, and ledger-write signals used by the subscription funding ratchet.
 */

import { readdirSync, readFileSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import ts from "typescript";
import type { SubscriptionDebitSignal } from "../src/lib/services/subscription-funding-policy";

export const CLOUD_ROOT = resolve(import.meta.dirname, "../..");

const SIGNAL_PATTERNS: Readonly<Record<SubscriptionDebitSignal, RegExp>> = {
  credit_service_deduct: /\.deductCredits\s*\(/g,
  // `reserve` is generic, so require a receiver whose name identifies credit authority. This
  // covers singleton aliases and explicitly named injected members such as `this.credits`.
  credit_service_reserve: /\b(?:[\w$]*credits?[\w$]*|this\.credits)\.reserve\s*\(/gi,
  credit_service_reserve_and_deduct: /\.reserveAndDeductCredits\s*\(/g,
  credit_transaction_repository_create: /\bcreditTransactionsRepository\.create\s*\(/g,
  debit_ledger_literal: /\btype\s*:\s*["']debit["']/g,
  organization_repository_deduct: /\.deductCreditsWithTransaction\s*\(/g,
  // The terminators keep this scan local to one balance expression without a silent length cliff.
  raw_credit_balance_decrement:
    /credit_balance\s*(?:=|:\s*sql`)\s*(?:(?![;`]).|\r?\n)*?(?<!-)\s*-(?!-)\s*/g,
  raw_credit_transaction_sql_insert: /\bINSERT\s+INTO\s+"?credit_transactions"?/gi,
  raw_credit_transaction_insert: /\.insert\s*\(\s*creditTransactions\s*\)/g,
};

function isProductionTypeScript(relativePath: string): boolean {
  // Operational scripts, migrations, and test harnesses are excluded deliberately: the ratchet
  // owns runtime debit boundaries, and those directories have separate execution authorities.
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

function maskCommentsAndNonSignalStrings(source: string): string {
  const masked = [...source];
  const sourceFile = ts.createSourceFile(
    "subscription-debit-audit.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const blank = (start: number, end: number): void => {
    for (let index = start; index < end; index += 1) {
      if (masked[index] !== "\n" && masked[index] !== "\r") masked[index] = " ";
    }
  };
  const visitedCommentPositions = new Set<number>();
  const blankCommentsAt = (position: number): void => {
    if (visitedCommentPositions.has(position)) return;
    visitedCommentPositions.add(position);
    for (const range of ts.getLeadingCommentRanges(source, position) ?? []) {
      blank(range.pos, range.end);
    }
    for (const range of ts.getTrailingCommentRanges(source, position) ?? []) {
      blank(range.pos, range.end);
    }
  };
  const visit = (node: ts.Node): void => {
    blankCommentsAt(node.pos);
    if (
      (ts.isStringLiteral(node) && node.text !== "debit") ||
      ts.isRegularExpressionLiteral(node)
    ) {
      blank(node.getStart(sourceFile), node.getEnd());
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  blankCommentsAt(sourceFile.endOfFileToken.pos);
  return masked.join("");
}

export function scanSubscriptionDebitSignals(
  source: string,
): Partial<Record<SubscriptionDebitSignal, number>> {
  const scannableSource = maskCommentsAndNonSignalStrings(source);
  const signals: Partial<Record<SubscriptionDebitSignal, number>> = {};
  for (const [signal, pattern] of Object.entries(SIGNAL_PATTERNS) as [
    SubscriptionDebitSignal,
    RegExp,
  ][]) {
    pattern.lastIndex = 0;
    const count = Array.from(scannableSource.matchAll(pattern)).length;
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
