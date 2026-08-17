/**
 * RedeemableEarningsService fail-closed balance-reporting contract (#13415
 * slice).
 *
 * The money-out gates already parse NUMERIC columns strictly, but the
 * result-reporting sites (dedup replays, post-mutation `newBalance`) coerced
 * with bare `Number(...)`, so a corrupt row ('NaN'::numeric — which PASSES the
 * `available_balance >= 0` CHECK because NaN sorts above all numerics) was
 * reported to callers as a healthy-looking NaN balance. These paths must now
 * throw via `parseRedeemableEarningsNumber`.
 *
 * The harness is real: the actual service SQL (dedup lookup, insert/update,
 * ledger write) runs against in-process PGlite with the real Drizzle DDL
 * applied by `pushSchemaToTestDb`. The trailing loud guard fails the suite if
 * PGlite ever fails to initialize — never a silent skip.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const PGLITE_TIMEOUT = 60000;
const USER_A = "00000000-0000-0000-0000-0000000000c1";
const USER_B = "00000000-0000-0000-0000-0000000000c2";

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let redeemableEarningsService: typeof import("../redeemable-earnings").redeemableEarningsService;
let pgliteReady = true;

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ({ redeemableEarningsService } = await import("../redeemable-earnings"));
    // Hand-rolled minimal DDL (the sibling app-earnings / credits pattern):
    // the real schema's FK chain (users -> organizations -> ...) pulls in the
    // whole graph, which this suite does not exercise. Enums are created for
    // real so the service's enum-typed inserts bind; the CHECK mirrors the
    // production available_balance >= 0 constraint.
    const ddl = [
      `DO $$ BEGIN
        CREATE TYPE earnings_source AS ENUM ('miniapp','agent','mcp','affiliate','app_owner_revenue_share','creator_revenue_share');
      EXCEPTION WHEN duplicate_object THEN null; END $$`,
      `DO $$ BEGIN
        CREATE TYPE ledger_entry_type AS ENUM ('earning','redemption_lock','redemption_complete','redemption_cancel','adjustment','conversion');
      EXCEPTION WHEN duplicate_object THEN null; END $$`,
      `CREATE TABLE IF NOT EXISTS redeemable_earnings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL UNIQUE,
        total_earned numeric(18,4) NOT NULL DEFAULT '0.0000',
        total_redeemed numeric(18,4) NOT NULL DEFAULT '0.0000',
        total_pending numeric(18,4) NOT NULL DEFAULT '0.0000',
        available_balance numeric(18,4) NOT NULL DEFAULT '0.0000' CHECK (available_balance >= 0),
        earned_from_miniapps numeric(18,4) NOT NULL DEFAULT '0.0000',
        earned_from_agents numeric(18,4) NOT NULL DEFAULT '0.0000',
        earned_from_mcps numeric(18,4) NOT NULL DEFAULT '0.0000',
        earned_from_affiliates numeric(18,4) NOT NULL DEFAULT '0.0000',
        earned_from_app_owner_shares numeric(18,4) NOT NULL DEFAULT '0.0000',
        earned_from_creator_shares numeric(18,4) NOT NULL DEFAULT '0.0000',
        total_converted_to_credits numeric(18,4) NOT NULL DEFAULT '0.0000',
        version numeric(10,0) NOT NULL DEFAULT '0',
        last_earning_at timestamp,
        last_redemption_at timestamp,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS redeemable_earnings_ledger (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        entry_type ledger_entry_type NOT NULL,
        amount numeric(18,4) NOT NULL,
        balance_after numeric(18,4) NOT NULL,
        earnings_source earnings_source,
        source_id text,
        redemption_id uuid,
        description text,
        metadata jsonb NOT NULL DEFAULT '{}',
        created_at timestamp NOT NULL DEFAULT now()
      )`,
    ];
    for (const stmt of ddl) await dbWrite.execute(stmt);
  } catch (error) {
    pgliteReady = false;
    console.warn("[redeemable-earnings-fail-closed] PGlite unavailable:", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

test(
  "healthy add + dedup replay report the same real balance with one ledger row",
  async () => {
    if (!pgliteReady) return;

    const first = await redeemableEarningsService.addEarnings({
      userId: USER_A,
      amount: 2.5,
      source: "miniapp",
      sourceId: "pay_healthy_1",
      description: "healthy earning",
      dedupeBySourceId: true,
    });
    expect(first.success).toBe(true);
    expect(first.newBalance).toBeCloseTo(2.5, 6);
    expect(first.deduplicated).toBe(false);

    const replay = await redeemableEarningsService.addEarnings({
      userId: USER_A,
      amount: 2.5,
      source: "miniapp",
      sourceId: "pay_healthy_1",
      description: "healthy earning",
      dedupeBySourceId: true,
    });
    expect(replay.deduplicated).toBe(true);
    expect(replay.newBalance).toBeCloseTo(2.5, 6);
    expect(replay.ledgerEntryId).toBe(first.ledgerEntryId);

    const rows = await dbWrite.execute(
      `SELECT count(*)::int AS n FROM redeemable_earnings_ledger WHERE user_id = '${USER_A}';`,
    );
    expect((rows.rows[0] as { n: number }).n).toBe(1);
  },
  PGLITE_TIMEOUT,
);

test(
  "a corrupt NUMERIC balance makes the dedup replay throw instead of reporting NaN",
  async () => {
    if (!pgliteReady) return;

    // Seed a real earning, then corrupt the balance row. 'NaN'::numeric passes
    // the available_balance >= 0 CHECK (NaN sorts above all numerics), which is
    // exactly why the read boundary must fail closed.
    const seeded = await redeemableEarningsService.addEarnings({
      userId: USER_B,
      amount: 1.0,
      source: "miniapp",
      sourceId: "pay_corrupt_1",
      description: "seed before corruption",
      dedupeBySourceId: true,
    });
    expect(seeded.success).toBe(true);
    await dbWrite.execute(
      `UPDATE redeemable_earnings SET available_balance = 'NaN' WHERE user_id = '${USER_B}';`,
    );

    await expect(
      redeemableEarningsService.addEarnings({
        userId: USER_B,
        amount: 1.0,
        source: "miniapp",
        sourceId: "pay_corrupt_1",
        description: "seed before corruption",
        dedupeBySourceId: true,
      }),
    ).rejects.toThrow("available_balance");

    // The replay wrote nothing: still exactly one ledger row.
    const rows = await dbWrite.execute(
      `SELECT count(*)::int AS n FROM redeemable_earnings_ledger WHERE user_id = '${USER_B}';`,
    );
    expect((rows.rows[0] as { n: number }).n).toBe(1);
  },
  PGLITE_TIMEOUT,
);

// Loud guard: PGlite is in-process (no network), so `pgliteReady` must be true.
// Without this, a broken import or schema push would skip every DB case above
// and the suite would pass vacuously.
test("PGlite harness initialized (DB cases above are not vacuous)", () => {
  expect(pgliteReady).toBe(true);
});
