// Builds/refreshes reverseIndex.generated.json: for every currently
// -registered exposure address, fully scans that address's own
// transaction history (via the existing Moralis wallet-history call) and
// records every counterparty it has ever transacted with. Checking a
// newly-investigated wallet against the resulting index is an O(1)
// lookup, giving exposure coverage independent of that wallet's own
// sample depth - the expensive work (scanning the small, fixed set of
// flagged addresses) happens here, once, amortized across every future
// investigation.
//
// Manually triggered for now (run this after adding a new exposure
// registry entry, or periodically by hand) - wiring into a scheduled job
// is a deliberate later step, not a prerequisite for this feature.
//
// Usage: bun run src/skunkscan/exposure/buildReverseIndex.ts
// Requires: MORALIS_API_KEY set in the environment this runs in.
//
// Caps (per flagged address): 100,000 transactions OR 20 minutes
// wall-clock, whichever comes first - sized from a live investigation
// where two Inferno Drainer contracts were still climbing after 47-51
// Moralis calls / ~90s with no end in sight; this is a one-time
// background job, not an interactive request, so it can afford far more
// time than that investigation's 90s research cap.

import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getEthereumTransactions } from "../moralis";
import { getExposureRegistryEntries } from "./staticRegistry";
import {
  RegistryAddressScanCoverage,
  ReverseExposureIndexEntry,
  ReverseIndexMatch,
} from "./reverseIndex";
import { SupportedChain, WalletRelationshipDirection } from "../types";

const MAX_TRANSACTIONS_PER_ADDRESS = 100_000;
const MAX_WALL_CLOCK_MS_PER_ADDRESS = 20 * 60 * 1000; // 20 minutes
const PAGE_SIZE = 100;
const RETRIES_PER_PAGE = 3;
const RETRY_BACKOFF_MS = 3_000;
const DELAY_BETWEEN_PAGES_MS = 500; // spacing to avoid the rate-limit-adjacent
// transient errors observed during the cost investigation when pages were
// fetched back-to-back with no delay at all.

type CounterpartyAccumulator = {
  incomingCount: number;
  outgoingCount: number;
  signatures: Set<string>;
  lastSeenAt: number;
};

type ScanResult = {
  status: "complete" | "capped" | "failed";
  transactionsScanned: number;
  oldestScannedBlock: number | null;
  oldestScannedAt: string | null;
  newestScannedBlock: number | null;
  newestScannedAt: string | null;
  cappedReason: string | null;
  failureReason: string | null;
  counterparties: Map<string, CounterpartyAccumulator>;
};

async function scanFlaggedAddress(address: string): Promise<ScanResult> {
  const counterparties = new Map<string, CounterpartyAccumulator>();

  let cursor: string | null = null;
  let page = 0;
  let totalTx = 0;
  let oldestBlock: number | null = null;
  let oldestAt: string | null = null;
  let newestBlock: number | null = null;
  let newestAt: string | null = null;

  const start = Date.now();
  let stopStatus: "complete" | "capped" | "failed" = "complete";
  let cappedReason: string | null = null;
  let failureReason: string | null = null;

  while (true) {
    if (totalTx >= MAX_TRANSACTIONS_PER_ADDRESS) {
      stopStatus = "capped";
      cappedReason = `hit MAX_TRANSACTIONS_PER_ADDRESS cap (${MAX_TRANSACTIONS_PER_ADDRESS})`;
      break;
    }
    if (Date.now() - start >= MAX_WALL_CLOCK_MS_PER_ADDRESS) {
      stopStatus = "capped";
      cappedReason = `hit wall-clock cap (${MAX_WALL_CLOCK_MS_PER_ADDRESS}ms)`;
      break;
    }

    let result: Awaited<ReturnType<typeof getEthereumTransactions>> | null =
      null;
    let lastErr: unknown = null;

    for (let attempt = 0; attempt < RETRIES_PER_PAGE; attempt++) {
      try {
        result = await getEthereumTransactions(
          address,
          "eth",
          PAGE_SIZE,
          cursor,
        );
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
      }
    }

    if (!result) {
      if (page === 0) {
        // Zero usable data ever obtained for this address - the provider
        // wouldn't cooperate, not a choice we made to stop.
        stopStatus = "failed";
        failureReason = `error on first page after ${RETRIES_PER_PAGE} retries: ${lastErr}`;
      } else {
        // Real partial data already exists from earlier successful pages -
        // this is a capped stop, not a failure, even though the proximate
        // cause was a provider error rather than our own size/time budget.
        stopStatus = "capped";
        cappedReason = `stopped after repeated provider errors on page ${page + 1} (${RETRIES_PER_PAGE} retries exhausted): ${lastErr}`;
      }
      break;
    }

    page += 1;

    for (const tx of result.transactions) {
      totalTx += 1;

      if (tx.blockNumber !== null) {
        if (oldestBlock === null || tx.blockNumber < oldestBlock) {
          oldestBlock = tx.blockNumber;
          oldestAt = tx.blockTimestamp
            ? new Date(tx.blockTimestamp * 1000).toISOString()
            : null;
        }
        if (newestBlock === null || tx.blockNumber > newestBlock) {
          newestBlock = tx.blockNumber;
          newestAt = tx.blockTimestamp
            ? new Date(tx.blockTimestamp * 1000).toISOString()
            : null;
        }
      }

      const timestamp = tx.blockTimestamp ?? 0;

      for (const transfer of [...tx.nativeTransfers, ...tx.tokenTransfers]) {
        const from = transfer.from_address?.toLowerCase();
        const to = transfer.to_address?.toLowerCase();
        const flagged = address.toLowerCase();

        if (from === flagged && to && to !== flagged) {
          // The flagged address sent to `to` - from `to`'s perspective,
          // this is an incoming transfer.
          const acc = counterparties.get(to) ?? {
            incomingCount: 0,
            outgoingCount: 0,
            signatures: new Set<string>(),
            lastSeenAt: 0,
          };
          acc.incomingCount += 1;
          acc.signatures.add(tx.hash);
          acc.lastSeenAt = Math.max(acc.lastSeenAt, timestamp);
          counterparties.set(to, acc);
        }

        if (to === flagged && from && from !== flagged) {
          // `from` sent to the flagged address - from `from`'s
          // perspective, this is an outgoing transfer.
          const acc = counterparties.get(from) ?? {
            incomingCount: 0,
            outgoingCount: 0,
            signatures: new Set<string>(),
            lastSeenAt: 0,
          };
          acc.outgoingCount += 1;
          acc.signatures.add(tx.hash);
          acc.lastSeenAt = Math.max(acc.lastSeenAt, timestamp);
          counterparties.set(from, acc);
        }
      }
    }

    if (!result.nextCursor || result.transactions.length === 0) {
      break; // genuine end of history - stopStatus stays "complete"
    }
    cursor = result.nextCursor;
    await new Promise((r) => setTimeout(r, DELAY_BETWEEN_PAGES_MS));
  }

  return {
    status: stopStatus,
    transactionsScanned: totalTx,
    oldestScannedBlock: oldestBlock,
    oldestScannedAt: oldestAt,
    newestScannedBlock: newestBlock,
    newestScannedAt: newestAt,
    cappedReason,
    failureReason,
    counterparties,
  };
}

function directionFromCounts(
  incomingCount: number,
  outgoingCount: number,
): WalletRelationshipDirection {
  if (incomingCount > 0 && outgoingCount > 0) return "bidirectional";
  if (outgoingCount > 0) return "outgoing";
  if (incomingCount > 0) return "incoming";
  return "unknown";
}

async function main() {
  if (!process.env.MORALIS_API_KEY) {
    console.error("MORALIS_API_KEY is not set.");
    process.exit(1);
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const outputPath = path.join(here, "reverseIndex.generated.json");

  // Chain-neutral: loops whatever chains actually have registered exposure
  // entries today (ethereum) - Solana's registry is empty, so this
  // produces nothing for it yet, and will start working automatically
  // once Solana entries exist, with no changes needed here.
  const chains: SupportedChain[] = ["ethereum", "solana"];

  const index: Record<string, Record<string, ReverseExposureIndexEntry>> = {};
  const coverage: Record<
    string,
    Record<string, RegistryAddressScanCoverage>
  > = {};

  for (const chain of chains) {
    const entries = getExposureRegistryEntries(chain);

    if (entries.length === 0) {
      continue;
    }

    if (chain !== "ethereum") {
      console.log(
        `Skipping ${chain}: reverse-index scanning is only implemented for Ethereum (Moralis) so far.`,
      );
      continue;
    }

    const chainIndex: Record<string, ReverseExposureIndexEntry> = {};
    const chainCoverage: Record<string, RegistryAddressScanCoverage> = {};

    for (const entry of entries) {
      console.log(`\nScanning ${entry.label} (${entry.address})...`);

      const scan = await scanFlaggedAddress(entry.address);

      console.log(
        `  status=${scan.status}, transactionsScanned=${scan.transactionsScanned}, counterparties=${scan.counterparties.size}`,
      );

      const flaggedLower = entry.address.toLowerCase();

      chainCoverage[flaggedLower] = {
        flaggedAddress: flaggedLower,
        chain,
        status: scan.status,
        transactionsScanned: scan.transactionsScanned,
        oldestScannedBlock: scan.oldestScannedBlock,
        oldestScannedAt: scan.oldestScannedAt,
        newestScannedBlock: scan.newestScannedBlock,
        newestScannedAt: scan.newestScannedAt,
        lastRefreshedAt: new Date().toISOString(),
        cappedReason: scan.cappedReason,
        failureReason: scan.failureReason,
      };

      for (const [counterparty, acc] of scan.counterparties) {
        const direction = directionFromCounts(
          acc.incomingCount,
          acc.outgoingCount,
        );

        const match: ReverseIndexMatch = {
          flaggedAddress: flaggedLower,
          direction,
          // Same asymmetric-scoring rule as the live counterparty check in
          // exposure.ts: incoming-only doesn't contribute.
          contributesToScore:
            direction === "outgoing" || direction === "bidirectional",
          transactionSignatures: Array.from(acc.signatures),
          lastSeenAt: acc.lastSeenAt,
        };

        const existing = chainIndex[counterparty];

        if (existing) {
          existing.matches.push(match);
        } else {
          chainIndex[counterparty] = { address: counterparty, matches: [match] };
        }
      }
    }

    index[chain] = chainIndex;
    coverage[chain] = chainCoverage;
  }

  const output = {
    generatedAt: new Date().toISOString(),
    index,
    coverage,
  };

  writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf8");

  console.log(`\nWrote ${outputPath}`);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
