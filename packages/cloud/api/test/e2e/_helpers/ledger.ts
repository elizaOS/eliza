/**
 * Direct ledger reads for e2e money assertions.
 *
 * The org balance ENDPOINT serves a cached value by design (CACHE_TTL
 * CREDIT_BALANCE = 5 min, not invalidated by billing debits), so an e2e that
 * polls it for a fresh debit flakes. The credit_transactions table is the
 * source of truth — assert there.
 */

import { dbRead } from "@elizaos/cloud-shared/db/helpers";
import { sql } from "drizzle-orm";

/**
 * Count org-ledger inference debits created at/after `since`. The
 * app-attributed path writes `Chat completion: <model>`; the plain org path
 * writes `AI request: <model>` — match both. Scoped to the preload's test org
 * (TEST_ORGANIZATION_ID) so unrelated traffic on shared staging can never
 * satisfy the assertion.
 */
export async function countAiRequestDebitsSince(since: Date): Promise<number> {
  const orgId = process.env.TEST_ORGANIZATION_ID;
  if (!orgId) {
    throw new Error(
      "countAiRequestDebitsSince: TEST_ORGANIZATION_ID is not set (preload seeds it)",
    );
  }
  const res = (await dbRead.execute(
    sql`SELECT count(*) AS n FROM credit_transactions
        WHERE type = 'debit'
          AND organization_id = ${orgId}
          AND (description LIKE 'AI request:%' OR description LIKE 'Chat completion:%')
          AND created_at >= ${since.toISOString()}`,
  )) as { rows?: Array<{ n?: string | number }> };
  return Number(res.rows?.[0]?.n ?? 0);
}

/** Count creator-earnings transactions for `appId` created at/after `since`. */
export async function countAppEarningsSince(
  appId: string,
  since: Date,
): Promise<number> {
  const res = (await dbRead.execute(
    sql`SELECT count(*) AS n FROM app_earnings_transactions
        WHERE app_id = ${appId}
          AND created_at >= ${since.toISOString()}`,
  )) as { rows?: Array<{ n?: string | number }> };
  return Number(res.rows?.[0]?.n ?? 0);
}
