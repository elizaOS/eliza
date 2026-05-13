/**
 * Earnings Reconciliation Script
 *
 * WHY THIS EXISTS:
 * `app_earnings.total_lifetime_earnings` is a denormalized sum maintained by
 * `appCreditsService.deductCredits()` (and a couple of reconcile paths) every
 * time an inference call earns markup. The full audit trail lives in
 * `app_earnings_transactions`. If a write path ever forgets to update the
 * summary, or applies a partial reverse on reconciliation, the summary drifts
 * silently — creators see one number on their dashboard while the ledger
 * holds the truth.
 *
 * This script diffs the summary against the ledger sum per app and reports
 * any drift over a configurable tolerance (default $0.000001 to absorb
 * fixed-precision rounding from `numeric(10, 6)`).
 *
 * Read-only — never mutates. Safe to run against production.
 *
 * Usage:
 *   DATABASE_URL=... bun run packages/scripts/reconcile-earnings.ts
 *   DATABASE_URL=... bun run packages/scripts/reconcile-earnings.ts --json
 *   DATABASE_URL=... bun run packages/scripts/reconcile-earnings.ts --tolerance 0.01
 *
 * Exit codes:
 *   0  no drift detected
 *   1  drift detected
 *   2  configuration/connection error
 */

import pg from "pg";

const { Client } = pg;

interface Args {
  json: boolean;
  tolerance: number;
}

interface AppEarningsRow {
  app_id: string;
  summary_total: number;
  ledger_sum: number;
  drift: number;
  ledger_transaction_count: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, tolerance: 0.000001 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      args.json = true;
    } else if (a === "--tolerance") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("--tolerance requires a value");
      }
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`--tolerance must be a non-negative number, got ${JSON.stringify(next)}`);
      }
      args.tolerance = parsed;
      i++;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

async function fetchDrift(client: pg.Client): Promise<AppEarningsRow[]> {
  // Sum the ledger per app. Lifetime earnings accrue from
  // `inference_markup` (chat/messages markup, see app-credits.ts) and
  // `purchase_share` (x402 purchase share, see x402-payment-requests.ts).
  // Reconciliation refunds reuse the same `inference_markup` type with a
  // negative `amount`, so a plain SUM gives the net lifetime total — no
  // separate "reversal" type to filter.
  const rows = await client.query<{
    app_id: string;
    summary_total: string;
    ledger_sum: string | null;
    ledger_transaction_count: string;
  }>(
    `
    SELECT
      e.app_id::text                                 AS app_id,
      e.total_lifetime_earnings::text                AS summary_total,
      COALESCE(SUM(t.amount)::text, '0')             AS ledger_sum,
      COUNT(t.id)::text                              AS ledger_transaction_count
    FROM app_earnings e
    LEFT JOIN app_earnings_transactions t
      ON t.app_id = e.app_id
      AND t.type IN ('inference_markup', 'purchase_share')
    GROUP BY e.app_id, e.total_lifetime_earnings
    ORDER BY e.app_id;
    `,
  );

  return rows.rows.map((r) => {
    const summary = Number(r.summary_total);
    const ledger = Number(r.ledger_sum ?? "0");
    return {
      app_id: r.app_id,
      summary_total: summary,
      ledger_sum: ledger,
      drift: summary - ledger,
      ledger_transaction_count: Number(r.ledger_transaction_count),
    };
  });
}

function formatDriftRow(row: AppEarningsRow): string {
  const driftStr = row.drift.toFixed(6);
  const sign = row.drift > 0 ? "+" : "";
  return `  ${row.app_id}  summary=${row.summary_total.toFixed(6)}  ledger=${row.ledger_sum.toFixed(6)}  drift=${sign}${driftStr}  (${row.ledger_transaction_count} txn)`;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[reconcile-earnings] ${(err as Error).message}`);
    return 2;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("[reconcile-earnings] DATABASE_URL is not set");
    return 2;
  }

  const client = new Client({ connectionString });
  try {
    await client.connect();
  } catch (err) {
    console.error(`[reconcile-earnings] failed to connect: ${(err as Error).message}`);
    return 2;
  }

  let rows: AppEarningsRow[];
  try {
    rows = await fetchDrift(client);
  } catch (err) {
    console.error(`[reconcile-earnings] query failed: ${(err as Error).message}`);
    await client.end();
    return 2;
  }
  await client.end();

  const drifted = rows.filter((r) => Math.abs(r.drift) > args.tolerance);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          tolerance: args.tolerance,
          apps_checked: rows.length,
          apps_with_drift: drifted.length,
          drift: drifted,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`[reconcile-earnings] Checked ${rows.length} app_earnings rows`);
    console.log(`[reconcile-earnings] Tolerance: ${args.tolerance}`);
    if (drifted.length === 0) {
      console.log("[reconcile-earnings] ✓ no drift detected");
    } else {
      console.log(`[reconcile-earnings] ✗ ${drifted.length} app(s) with drift over tolerance:`);
      for (const row of drifted) {
        console.log(formatDriftRow(row));
      }
    }
  }

  return drifted.length === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    console.error(`[reconcile-earnings] fatal: ${(err as Error).stack ?? err}`);
    process.exit(2);
  });
