/**
 * Inspect the domain-purchase ledger (#10691).
 *
 * Lists every domain the live lane ever attempted/bought (JSONL, append-only)
 * with quoted/debited amounts, per-domain lifecycle, and total spend.
 *
 *   bun run --cwd packages/test/cloud-e2e domains:ledger
 *   bun run --cwd packages/test/cloud-e2e domains:ledger -- <path-to-ledger.jsonl>
 *
 * jq equivalent (purchases only):
 *   jq -r 'select(.phase=="purchased") |
 *     [.timestamp,.runId,.domain,((.debitedTotalUsdCents//0)|tostring)+"¢",.zoneId//"-"] | @tsv' \
 *     domain-purchase-ledger/ledger.jsonl
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DomainLedgerEntry } from "../src/helpers/domain-purchase";

const DEFAULT_PATH = resolve(
  import.meta.dirname,
  "../domain-purchase-ledger/ledger.jsonl",
);
const ledgerPath = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : DEFAULT_PATH;

if (!existsSync(ledgerPath)) {
  console.log(
    `[domain-ledger] no ledger at ${ledgerPath} — no purchases recorded yet.`,
  );
  process.exit(0);
}

const entries = readFileSync(ledgerPath, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line, i) => {
    try {
      return JSON.parse(line) as DomainLedgerEntry;
    } catch (err) {
      throw new Error(
        `[domain-ledger] malformed JSONL at ${ledgerPath}:${i + 1}: ${String(err)}`,
      );
    }
  });

console.log(`[domain-ledger] ${ledgerPath} — ${entries.length} entries\n`);

const byDomain = new Map<string, DomainLedgerEntry[]>();
for (const entry of entries) {
  const list = byDomain.get(entry.domain) ?? [];
  list.push(entry);
  byDomain.set(entry.domain, list);
}

let totalDebitedCents = 0;
let purchases = 0;
for (const [domain, events] of byDomain) {
  const purchased = events.find((e) => e.phase === "purchased");
  const detached = events.find((e) => e.phase === "detached");
  const failed = events.find((e) => e.phase === "buy-failed");
  if (purchased?.debitedTotalUsdCents) {
    totalDebitedCents += purchased.debitedTotalUsdCents;
    purchases += 1;
  }
  const state = purchased
    ? `PURCHASED ${purchased.debitedTotalUsdCents ?? "?"}¢${detached ? " → detached" : " (STILL ATTACHED)"}`
    : failed
      ? `FAILED (HTTP ${failed.httpStatus ?? "?"}: ${failed.error ?? "unknown"})`
      : "attempted only";
  const first = events[0];
  console.log(
    `  ${domain}  [${first.mode}]  run=${first.runId}  ${first.timestamp}  ${state}` +
      (purchased?.zoneId ? `  zone=${purchased.zoneId}` : ""),
  );
}

console.log(
  `\n[domain-ledger] ${purchases} completed purchase(s), total debited ${totalDebitedCents}¢ ($${(totalDebitedCents / 100).toFixed(2)}).`,
);
console.log(
  "[domain-ledger] reminder: detach removes the app attachment only — Cloudflare registrations are non-refundable and remain until expiry.",
);
