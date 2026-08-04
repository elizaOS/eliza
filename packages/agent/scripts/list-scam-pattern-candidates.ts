/**
 * Minimal read-only viewer for pending scam-pattern candidates
 * (skunkscan.scam_pattern_candidates). Connects to the same PGlite/Postgres
 * database an already-booted agent uses (via @elizaos/plugin-sql's
 * createDatabaseAdapter(), same PGLITE_DATA_DIR/POSTGRES_URL resolution the
 * real agent uses) and prints what's been captured so far - no Moralis/
 * Helius calls, no writes, no review-status transitions.
 *
 * Usage: bun run --cwd packages/agent list-candidates [--status=pending] [--limit=25]
 */

import { randomUUID } from "node:crypto";
import { createDatabaseAdapter } from "@elizaos/plugin-sql";
import { ScamPatternCandidateStore } from "../src/skunkscan/candidates/store.ts";
import { scamPatternCandidatesSchema } from "../src/skunkscan/candidates/schema.ts";
import type { RuntimeDb } from "../src/skunkscan/candidates/sql.ts";
import type { ReviewStatus } from "../src/skunkscan/candidates/types.ts";

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

const VALID_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "accepted",
  "rejected",
]);

async function main() {
  const statusArg = readArg("status") ?? "pending";
  if (!VALID_STATUSES.has(statusArg)) {
    throw new Error(
      `--status must be one of pending|accepted|rejected, got: ${statusArg}`,
    );
  }
  const reviewStatus = statusArg as ReviewStatus;
  const limit = Number(readArg("limit") ?? "25");

  const adapter = createDatabaseAdapter(
    {
      dataDir: process.env.PGLITE_DATA_DIR,
      postgresUrl: process.env.POSTGRES_URL,
    },
    randomUUID(),
  );

  await adapter.initialize();

  try {
    // Ensures the skunkscan.scam_pattern_candidates table exists - the same
    // additive, idempotent migration step the real agent already runs at
    // boot, scoped to just this one schema. Read-only in effect: it never
    // touches existing rows.
    await adapter.runPluginMigrations?.([
      { name: "skunkscan-candidates", schema: scamPatternCandidatesSchema },
    ]);

    const store = new ScamPatternCandidateStore(adapter.db as RuntimeDb);
    const candidates = await store.list({ reviewStatus, limit });

    if (candidates.length === 0) {
      console.log(`No ${reviewStatus} scam-pattern candidates found.`);
      return;
    }

    console.log(
      `${candidates.length} ${reviewStatus} scam-pattern candidate(s):\n`,
    );

    for (const candidate of candidates) {
      console.log("=".repeat(72));
      console.log(`Address:   ${candidate.address}  (${candidate.chain})`);
      console.log(`Patterns:  ${candidate.patterns.join(", ")}`);
      console.log(`Status:    ${candidate.reviewStatus}`);
      console.log(`Created:   ${candidate.createdAt.toISOString()}`);

      if (candidate.hasKnownLabelMatch) {
        console.log(
          `\n  !! ALREADY LABELED - review this before treating as a lead !!`,
        );
        for (const match of candidate.labelMatches) {
          console.log(
            `     ${match.address} (${match.relationship}) -> "${match.label}"`,
          );
        }
      } else {
        console.log(`Label check: no known-label matches`);
      }

      const evidence = candidate.evidence as Record<string, unknown>;
      console.log(`\n  Evidence:`);
      console.log(`     drainRatio:    ${evidence.drainRatio}`);
      console.log(`     dormancyDays:  ${evidence.dormancyDays}`);
      console.log(
        `     inboundTotalNative:  ${evidence.inboundTotalNative}`,
      );
      console.log(
        `     outboundTotalNative: ${evidence.outboundTotalNative}`,
      );
      console.log(
        `     hoursBetweenInboundAndOutbound: ${evidence.hoursBetweenInboundAndOutbound}`,
      );

      if (candidate.reviewNotes) {
        console.log(`\n  Review notes: ${candidate.reviewNotes}`);
      }
    }
    console.log("=".repeat(72));
  } finally {
    await adapter.close();
  }
}

main().catch((error) => {
  console.error("FAILED:", error);
  process.exit(1);
});
