/**
 * Proof harness for seed-credit-packs.ts (#22963 AC4): applies the real
 * migration journal to a temp PGlite store, then runs the REWRITTEN seeder as
 * a hermetic subprocess. Proves: (1) first run inserts all three packs,
 * (2) rerun is idempotent — existing rows are reported and left byte-identical
 * (no silent economics rewrite, which is AC2 product-gated), (3) partial env
 * fails closed before any write, (4) --dry-run writes nothing, (5) --json is
 * machine-parseable. Run:
 *   bun test packages/cloud/scripts/admin/seed-credit-packs.proof.test.ts
 *
 * Same cold-subprocess constraints as audit-credit-packs.proof.test.ts: every
 * test gets an explicit 60s timeout and children resolve packages from
 * cloud-shared's isolated node_modules tree.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = `${import.meta.dir}/seed-credit-packs.ts`;

/** Hermetic child env: no inherited .env (the seeder loads .env itself), keys stripped. */
function childEnv(dbUrl: string, extra: Record<string, string> = {}) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_PATH: path.resolve(import.meta.dir, "../../shared/node_modules"),
    DATABASE_URL: dbUrl,
    DISABLE_LOCAL_PGLITE_FALLBACK: "1",
    ...extra,
  };
}

const FULL_PACK_ENV = {
  STRIPE_SMALL_PACK_PRICE_ID: "price_proof_small",
  STRIPE_SMALL_PACK_PRODUCT_ID: "prod_proof_small",
  STRIPE_MEDIUM_PACK_PRICE_ID: "price_proof_medium",
  STRIPE_MEDIUM_PACK_PRODUCT_ID: "prod_proof_medium",
  STRIPE_LARGE_PACK_PRICE_ID: "price_proof_large",
  STRIPE_LARGE_PACK_PRODUCT_ID: "prod_proof_large",
};

async function freshDb(): Promise<{ dir: string; url: string }> {
  const dir = await mkdtemp(`${tmpdir()}/22963-seeder-`);
  const url = `pglite://${dir}`;
  const proc = Bun.spawnSync([process.execPath, "run", "db:migrate"], {
    cwd: `${import.meta.dir}/../../shared`,
    env: { ...childEnv(url) },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`migrate failed: ${proc.stderr.toString().slice(-400)}`);
  }
  return { dir, url };
}

function runSeeder(
  dbUrl: string,
  args: string[] = [],
  env: Record<string, string> = {},
) {
  const out = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
    env: childEnv(dbUrl, env),
    cwd: path.dirname(SCRIPT),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: out.exitCode,
    stdout: out.stdout.toString(),
    stderr: out.stderr.toString(),
  };
}

/** Read pack rows back through the audit script's JSON mode (already merged tooling). */
async function readPacksJson(url: string) {
  const audit = Bun.spawnSync(
    [process.execPath, `${import.meta.dir}/audit-credit-packs.ts`, "--json"],
    {
      env: childEnv(url, { STRIPE_SECRET_KEY: "" }),
      cwd: path.dirname(SCRIPT),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (audit.exitCode !== 0) {
    throw new Error(
      `audit read failed: ${audit.stderr.toString().slice(-400)}`,
    );
  }
  return JSON.parse(audit.stdout.toString());
}

/**
 * Read the raw `credit_packs` rows through the SAME db client the seeder
 * uses — every persisted column, timestamps included — so the immutability
 * proof compares database rows, not a projection that may omit columns.
 */
async function readRawRows(url: string) {
  const proc = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
      const [{ db }, { creditPacks }] = await Promise.all([
        import("../../shared/src/db/client"),
        import("../../shared/src/db/schemas/credit-packs"),
      ]);
      const rows = await db.select().from(creditPacks);
      // JSON round-trip normalizes Dates to ISO strings for stable comparison.
      console.log(JSON.stringify(rows, null, 2));
      // The pg pool keeps the event loop alive; exit explicitly.
      process.exit(0);
      `,
    ],
    {
      env: childEnv(url),
      cwd: path.dirname(SCRIPT),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (proc.exitCode !== 0) {
    throw new Error(`raw read failed: ${proc.stderr.toString().slice(-400)}`);
  }
  return JSON.parse(proc.stdout.toString()) as Array<Record<string, unknown>>;
}

/** Read full stripe_checkout_orders rows through the seeder's db client. */
async function readRawOrders(url: string) {
  const proc = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
      const [{ db }, { stripeCheckoutOrders }] = await Promise.all([
        import("../../shared/src/db/client"),
        import("../../shared/src/db/schemas/stripe-checkout-orders"),
      ]);
      const rows = await db.select().from(stripeCheckoutOrders);
      console.log(JSON.stringify(rows.map((r) => ({
        ...r,
        charge_amount_cents: String(r.charge_amount_cents),
      }))));
      process.exit(0);
      `,
    ],
    {
      env: childEnv(url),
      cwd: path.dirname(SCRIPT),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (proc.exitCode !== 0) {
    throw new Error(`order read failed: ${proc.stderr.toString().slice(-400)}`);
  }
  return proc;
}

/** Stable row key independent of column order. */
function rowKey(row: Record<string, unknown>): string {
  return String(row.stripe_price_id ?? row.id ?? JSON.stringify(row));
}

describe("seed-credit-packs idempotence (#22963)", () => {
  test("first run inserts all packs; rerun is idempotent and leaves existing rows untouched", async () => {
    const { dir, url } = await freshDb();
    try {
      const first = runSeeder(url, ["--json"], FULL_PACK_ENV);
      expect(first.exitCode).toBe(0);
      const firstJson = JSON.parse(first.stdout);
      expect(firstJson.inserted).toHaveLength(3);
      expect(firstJson.kept).toHaveLength(0);

      const second = runSeeder(url, ["--json"], FULL_PACK_ENV);
      expect(second.exitCode).toBe(0);
      const secondJson = JSON.parse(second.stdout);
      expect(secondJson.inserted).toHaveLength(0);
      expect(secondJson.kept).toHaveLength(3);
      for (const kept of secondJson.kept) {
        // Economics stay exactly what the first run wrote — a rerun must
        // never rewrite credits/price of an existing pack row.
        expect(kept.credits).toBe(
          kept.name === "Small Pack"
            ? "5.00"
            : kept.name === "Medium Pack"
              ? "15.00"
              : "50.00",
        );
        expect(kept.is_active).toBe(true);
      }

      const packs = await readPacksJson(url);
      expect(packs.packs).toHaveLength(3);

      // Full-row immutability proof at the DATABASE level: every persisted
      // column (timestamps, metadata, product wiring included) is compared
      // exactly across a rerun, read through the same db client the seeder
      // uses (#22963 AC4).
      const rowsBefore = await readRawRows(url);
      expect(rowsBefore).toHaveLength(3);
      const third = runSeeder(url, ["--json"], FULL_PACK_ENV);
      expect(third.exitCode).toBe(0);
      const rowsAfter = await readRawRows(url);
      expect(rowsAfter).toHaveLength(3);
      const afterByKey = new Map(rowsAfter.map((r) => [rowKey(r), r]));
      for (const before of rowsBefore) {
        const after = afterByKey.get(rowKey(before));
        expect(after).toBeDefined();
        expect(after).toEqual(before);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("missing env identifiers fail closed before any write", async () => {
    const { dir, url } = await freshDb();
    try {
      const partial = { ...FULL_PACK_ENV };
      delete partial.STRIPE_MEDIUM_PACK_PRICE_ID;
      const r = runSeeder(url, [], partial);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("STRIPE_MEDIUM_PACK_PRICE_ID");

      const packs = await readPacksJson(url);
      expect(packs.packs).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("--dry-run writes nothing and reports the would-insert plan", async () => {
    const { dir, url } = await freshDb();
    try {
      const r = runSeeder(url, ["--dry-run"], FULL_PACK_ENV);
      expect(r.exitCode).toBe(0);
      const packs = await readPacksJson(url);
      expect(packs.packs).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("repair stamps are reason-scoped: unrelated stamps never mask a missing repair, and matching stamps never double (#22963 AC4)", async () => {
    const { dir, url } = await freshDb();
    try {
      // Case A: an ACTIVE stale row already carrying the repair-matching
      // stamp — the reason-scoped check must still deactivate it without
      // appending a second matching stamp.
      // Case B: an INACTIVE stale row carrying only an UNRELATED stamp —
      // it must receive the repair stamp (stamp count alone must not mask
      // a missing repair marker).
      const writer = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `
          const [{ db }, { creditPacks }] = await Promise.all([
            import("../../shared/src/db/client"),
            import("../../shared/src/db/schemas/credit-packs"),
          ]);
          await db.insert(creditPacks).values([
            {
              name: "Active With Repair Stamp",
              description: "case A",
              credits: "5.00",
              price_cents: 4999,
              stripe_price_id: "price_case_a",
              stripe_product_id: "prod_case_a",
              is_active: true,
              sort_order: 10,
              metadata: { deprecation_stamps: [{ reason: "stripe_price_id_no_longer_configured", at: "2020-01-01T00:00:00.000Z" }] },
            },
            {
              name: "Inactive With Unrelated Stamp",
              description: "case B",
              credits: "5.00",
              price_cents: 4999,
              stripe_price_id: "price_case_b",
              stripe_product_id: "prod_case_b",
              is_active: false,
              sort_order: 11,
              metadata: { deprecation_stamps: [{ reason: "operator_archived", at: "2020-01-01T00:00:00.000Z" }] },
            },
          ]);
          process.exit(0);
          `,
        ],
        {
          env: childEnv(url),
          cwd: path.dirname(SCRIPT),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(writer.exitCode).toBe(0);

      const repair1 = runSeeder(url, ["--json"], FULL_PACK_ENV);
      expect(repair1.exitCode).toBe(0);
      const json1 = JSON.parse(repair1.stdout);
      expect(json1.inserted).toHaveLength(3);
      expect(json1.deprecated).toHaveLength(2);

      const rows = await readRawRows(url);
      const byPrice = new Map(rows.map((r) => [String(r.stripe_price_id), r]));
      const caseA = byPrice.get("price_case_a") as Record<string, unknown>;
      const caseB = byPrice.get("price_case_b") as Record<string, unknown>;

      // Case A: deactivated, still exactly ONE repair-reason stamp.
      expect(caseA.is_active).toBe(false);
      const stampsA = (caseA.metadata as Record<string, unknown>)
        .deprecation_stamps as Array<{ reason: string }>;
      expect(
        stampsA.filter(
          (st) => st.reason === "stripe_price_id_no_longer_configured",
        ),
      ).toHaveLength(1);

      // Case B: already inactive, but the repair stamp is ADDED because the
      // existing stamp was unrelated.
      const stampsB = (caseB.metadata as Record<string, unknown>)
        .deprecation_stamps as Array<{ reason: string }>;
      expect(
        stampsB.filter(
          (st) => st.reason === "stripe_price_id_no_longer_configured",
        ),
      ).toHaveLength(1);
      expect(stampsB).toHaveLength(2); // unrelated stamp preserved

      // Rerun: zero further work — both rows are now inactive WITH matching
      // repair stamps.
      const repair2 = runSeeder(url, ["--json"], FULL_PACK_ENV);
      expect(repair2.exitCode).toBe(0);
      expect(JSON.parse(repair2.stdout).deprecated).toHaveLength(0);
      const rows2 = await readRawRows(url);
      const byPrice2 = new Map(
        rows2.map((r) => [String(r.stripe_price_id), r]),
      );
      for (const [id, before] of byPrice) {
        expect(byPrice2.get(id)).toEqual(before);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test("deprecates stale catalogue rows exactly once and preserves historical order facts (#22963 AC4)", async () => {
    const { dir, url } = await freshDb();
    try {
      // Seed a LEGACY catalogue under old price ids, then point the env at
      // NEW price ids: the legacy rows become stale on the next run.
      const legacyEnv = {
        STRIPE_SMALL_PACK_PRICE_ID: "price_legacy_small",
        STRIPE_SMALL_PACK_PRODUCT_ID: "prod_legacy_small",
        STRIPE_MEDIUM_PACK_PRICE_ID: "price_legacy_medium",
        STRIPE_MEDIUM_PACK_PRODUCT_ID: "prod_legacy_medium",
        STRIPE_LARGE_PACK_PRICE_ID: "price_legacy_large",
        STRIPE_LARGE_PACK_PRODUCT_ID: "prod_legacy_large",
      };
      const legacy = runSeeder(url, ["--json"], legacyEnv);
      expect(legacy.exitCode).toBe(0);
      expect(JSON.parse(legacy.stdout).inserted).toHaveLength(3);

      // A historical order references the legacy Small Pack row — the repair
      // must never touch it, and the pack row must survive for the FK.
      const insertOrder = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `
          const [{ db }, { creditPacks }, { stripeCheckoutOrders }, { organizations }, { users }] = await Promise.all([
            import("../../shared/src/db/client"),
            import("../../shared/src/db/schemas/credit-packs"),
            import("../../shared/src/db/schemas/stripe-checkout-orders"),
            import("../../shared/src/db/schemas/organizations"),
            import("../../shared/src/db/schemas/users"),
          ]);
          const [pack] = await db.select().from(creditPacks);
          const orgId = "22222222-2222-4222-8222-222222222222";
          const userId = "33333333-3333-4333-8333-333333333333";
          await db.insert(organizations).values({
            id: orgId,
            name: "Historical Org",
            slug: "historical-org",
          }).onConflictDoNothing();
          await db.insert(users).values({
            id: userId,
            steward_user_id: "historical-user-1",
            organization_id: orgId,
          }).onConflictDoNothing();
          const orderId = "11111111-1111-4111-8111-111111111111";
          await db.insert(stripeCheckoutOrders).values({
            id: orderId,
            organization_id: orgId,
            initiated_by_user_id: userId,
            purchase_type: "credit_pack",
            credit_pack_id: pack.id,
            credits_to_grant: pack.credits,
            charge_amount_cents: pack.price_cents,
            currency: "usd",
            status: "delivered",
            stripe_customer_id: "cus_historical",
            stripe_checkout_session_id: "cs_historical",
            client_request_key: "historical-order-1", // gitleaks:allow synthetic idempotency-key fixture, no entropy
            request_digest:
              "1111111111111111111111111111111111111111111111111111111111111111",
          });
          const rows = await db.select().from(stripeCheckoutOrders);
          // Full row with BigInt normalized to string for JSON transport.
          console.log(JSON.stringify(rows.map((r) => ({
            ...r,
            charge_amount_cents: String(r.charge_amount_cents),
          }))));
          process.exit(0);
          `,
        ],
        {
          env: childEnv(url),
          cwd: path.dirname(SCRIPT),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(insertOrder.exitCode).toBe(0);
      const historicalOrder = JSON.parse(insertOrder.stdout.toString());
      expect(historicalOrder).toHaveLength(1);

      // Repair run 1: legacy rows are stale; each must be deactivated and
      // stamped EXACTLY ONCE, never deleted, and the configured catalogue
      // inserted alongside.
      const repair1 = runSeeder(url, ["--json"], FULL_PACK_ENV);
      expect(repair1.exitCode).toBe(0);
      const repair1Json = JSON.parse(repair1.stdout);
      expect(repair1Json.inserted).toHaveLength(3);
      expect(repair1Json.deprecated).toHaveLength(3);

      // Receipt preservation across repair 1: the FULL historical order row
      // (credit_pack_id, request_digest, org/user ids, stripe ids, timestamps,
      // metadata included) must be unchanged by the deprecation write.
      const orderAfterRepair1 = JSON.parse(
        (await readRawOrders(url)).stdout.toString(),
      );
      expect(orderAfterRepair1).toEqual(historicalOrder);

      const rowsAfterRepair1 = await readRawRows(url);
      expect(rowsAfterRepair1).toHaveLength(6);
      const legacyRows1 = rowsAfterRepair1.filter((r) =>
        String(r.stripe_price_id).startsWith("price_legacy_"),
      );
      expect(legacyRows1).toHaveLength(3);
      for (const row of legacyRows1) {
        expect(row.is_active).toBe(false);
        const stamps = (row.metadata as Record<string, unknown>)
          ?.deprecation_stamps as unknown[];
        expect(Array.isArray(stamps)).toBe(true);
        expect(stamps).toHaveLength(1);
        expect(stamps[0]).toMatchObject({
          reason: "stripe_price_id_no_longer_configured",
        });
      }

      // Repair run 2: the same state must converge — no further stamps, no
      // further row changes, and the historical order stays byte-identical.
      const beforeSecond = await readRawRows(url);
      const repair2 = runSeeder(url, ["--json"], FULL_PACK_ENV);
      expect(repair2.exitCode).toBe(0);
      const repair2Json = JSON.parse(repair2.stdout);
      expect(repair2Json.deprecated).toHaveLength(0);
      const afterSecond = await readRawRows(url);
      expect(afterSecond).toHaveLength(6);
      const afterByKey = new Map(afterSecond.map((r) => [rowKey(r), r]));
      for (const before of beforeSecond) {
        const after = afterByKey.get(rowKey(before));
        expect(after).toBeDefined();
        expect(after).toEqual(before);
      }

      const orderCheck = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `
          const [{ db }, { stripeCheckoutOrders }] = await Promise.all([
            import("../../shared/src/db/client"),
            import("../../shared/src/db/schemas/stripe-checkout-orders"),
          ]);
          const rows = await db.select().from(stripeCheckoutOrders);
          console.log(JSON.stringify(rows.map((r) => ({
            ...r,
            charge_amount_cents: String(r.charge_amount_cents),
          }))));
          process.exit(0);
          `,
        ],
        {
          env: childEnv(url),
          cwd: path.dirname(SCRIPT),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(orderCheck.exitCode).toBe(0);
      expect(JSON.parse(orderCheck.stdout.toString())).toEqual(historicalOrder);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test("A→B→A configuration rollback restores the reconfigured row as sellable (#22963 review)", async () => {
    const { dir, url } = await freshDb();
    try {
      // Run A: catalogue under the proof price ids.
      const runA1 = runSeeder(url, ["--json"], FULL_PACK_ENV);
      expect(runA1.exitCode).toBe(0);
      expect(JSON.parse(runA1.stdout).inserted).toHaveLength(3);
      const rowsA1 = await readRawRows(url);
      const mediumA1 = rowsA1.find(
        (r) => r.stripe_price_id === "price_proof_medium",
      );
      expect(mediumA1).toBeDefined();

      // Run B: Medium's price id is reconfigured to a new provider price
      // (provider-side rollback/repoint). price_proof_medium becomes stale
      // and must be deactivated + stamped; the new id is inserted active.
      const envB = {
        ...FULL_PACK_ENV,
        STRIPE_MEDIUM_PACK_PRICE_ID: "price_proof_rollback_medium",
        STRIPE_MEDIUM_PACK_PRODUCT_ID: "prod_proof_rollback_medium",
      };
      const runB = runSeeder(url, ["--json"], envB);
      expect(runB.exitCode).toBe(0);
      const runBJson = JSON.parse(runB.stdout);
      expect(runBJson.inserted).toHaveLength(1);
      expect(runBJson.deprecated).toHaveLength(1);
      const rowsB = await readRawRows(url);
      const staleMedium = rowsB.find(
        (r) => r.stripe_price_id === "price_proof_medium",
      );
      expect(staleMedium?.is_active).toBe(false);

      // Run A again: the configuration rolls BACK to price_proof_medium
      // (provider restored the price). The reconfigured row must become
      // sellable again — availability restored, economics untouched, prior
      // deprecation stamp preserved as history, exactly one reactivation
      // stamp appended — and the superseded B row must be deactivated.
      const runA2 = runSeeder(url, ["--json"], FULL_PACK_ENV);
      expect(runA2.exitCode).toBe(0);
      const runA2Json = JSON.parse(runA2.stdout);
      expect(runA2Json.inserted).toHaveLength(0);
      expect(runA2Json.deprecated).toHaveLength(1);
      expect(runA2Json.reactivated).toHaveLength(1);

      const rowsA2 = await readRawRows(url);
      expect(rowsA2).toHaveLength(4);
      const restored = rowsA2.find(
        (r) => r.stripe_price_id === "price_proof_medium",
      );
      const superseded = rowsA2.find(
        (r) => r.stripe_price_id === "price_proof_rollback_medium",
      );

      // The reviewer's core assertion: the restored configured row is ACTIVE
      // (sellable) and the superseded row is inactive.
      expect(restored?.is_active).toBe(true);
      expect(superseded?.is_active).toBe(false);

      // Economics and provider identity survive the round-trip byte-exactly
      // (only availability metadata may change).
      expect(restored?.credits).toBe(mediumA1?.credits);
      expect(restored?.price_cents).toBe(mediumA1?.price_cents);
      expect(restored?.stripe_product_id).toBe(mediumA1?.stripe_product_id);
      expect(restored?.name).toBe(mediumA1?.name);

      // Append-only stamp history: the deprecation stamp from run B is
      // preserved and exactly one reactivation stamp documents the rollback.
      const stampsA2 = ((restored?.metadata as Record<string, unknown>)
        ?.deprecation_stamps ?? []) as Array<{ reason: string }>;
      expect(
        stampsA2.filter(
          (st) => st.reason === "stripe_price_id_no_longer_configured",
        ),
      ).toHaveLength(1);
      const reactStamps = ((restored?.metadata as Record<string, unknown>)
        ?.reactivation_stamps ?? []) as Array<{ reason: string }>;
      expect(reactStamps).toHaveLength(1);
      expect(reactStamps[0]?.reason).toBe("stripe_price_id_configured_again");

      // Rerun at rest: fully idempotent — no further stamp appends, no row
      // changes of any kind.
      const beforeRest = await readRawRows(url);
      const runA3 = runSeeder(url, ["--json"], FULL_PACK_ENV);
      expect(runA3.exitCode).toBe(0);
      expect(JSON.parse(runA3.stdout).deprecated).toHaveLength(0);
      const afterRest = await readRawRows(url);
      expect(afterRest).toHaveLength(beforeRest.length);
      const restByKey = new Map(afterRest.map((r) => [rowKey(r), r]));
      for (const before of beforeRest) {
        expect(restByKey.get(rowKey(before))).toEqual(before);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);

  test("operator archive after a repair reactivation stays archived (#22963 review)", async () => {
    const { dir, url } = await freshDb();
    try {
      // A→B→A: price_proof_medium is reactivated by the repair.
      const runA1 = runSeeder(url, ["--json"], FULL_PACK_ENV);
      expect(runA1.exitCode).toBe(0);
      const runB = runSeeder(url, ["--json"], {
        ...FULL_PACK_ENV,
        STRIPE_MEDIUM_PACK_PRICE_ID: "price_proof_rollback_medium",
        STRIPE_MEDIUM_PACK_PRODUCT_ID: "prod_proof_rollback_medium",
      });
      expect(runB.exitCode).toBe(0);
      const runA2 = runSeeder(url, ["--json"], FULL_PACK_ENV);
      expect(runA2.exitCode).toBe(0);
      expect(JSON.parse(runA2.stdout).reactivated).toHaveLength(1);
      const restored = (await readRawRows(url)).find(
        (r) => r.stripe_price_id === "price_proof_medium",
      );
      expect(restored?.is_active).toBe(true);

      // An operator archives the pack OUT-OF-BAND: plain is_active=false,
      // no metadata/stamp write. This is an operator decision, not repair
      // state — a rerun must NOT reactivate the row.
      const archiver = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `
          const [{ db }, { creditPacks }] = await Promise.all([
            import("../../shared/src/db/client"),
            import("../../shared/src/db/schemas/credit-packs"),
          ]);
          const { eq } = await import("drizzle-orm");
          await db.update(creditPacks).set({ is_active: false })
            .where(eq(creditPacks.stripe_price_id, "price_proof_medium"));
          process.exit(0);
          `,
        ],
        {
          env: childEnv(url),
          cwd: path.dirname(SCRIPT),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(archiver.exitCode).toBe(0);

      const rerun = runSeeder(url, ["--json"], FULL_PACK_ENV);
      expect(rerun.exitCode).toBe(0);
      const rerunJson = JSON.parse(rerun.stdout);
      // The core provenance assertion: historical repair stamps exist on the
      // row, but the present inactive state was produced by the operator —
      // reactivation must NOT fire.
      expect(rerunJson.reactivated).toHaveLength(0);

      const rows = await readRawRows(url);
      const archived = rows.find(
        (r) => r.stripe_price_id === "price_proof_medium",
      );
      expect(archived?.is_active).toBe(false);
      const reactStamps = ((archived?.metadata as Record<string, unknown>)
        ?.reactivation_stamps ?? []) as unknown[];
      expect(reactStamps).toHaveLength(1); // no new stamp appended
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);

  test("operator archive after an OBSERVED out-of-band revival stays archived (#22963 review)", async () => {
    const { dir, url } = await freshDb();
    try {
      // A→B: price_proof_medium is deactivated by the stale-repair.
      const runA1 = runSeeder(url, ["--json"], FULL_PACK_ENV);
      expect(runA1.exitCode).toBe(0);
      const runB = runSeeder(url, ["--json"], {
        ...FULL_PACK_ENV,
        STRIPE_MEDIUM_PACK_PRICE_ID: "price_proof_rollback_medium",
        STRIPE_MEDIUM_PACK_PRODUCT_ID: "prod_proof_rollback_medium",
      });
      expect(runB.exitCode).toBe(0);

      // Operator revives the pack out-of-band (plain is_active=true, no
      // metadata write) while the price is still unconfigured.
      const reviver = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `
          const [{ db }, { creditPacks }] = await Promise.all([
            import("../../shared/src/db/client"),
            import("../../shared/src/db/schemas/credit-packs"),
          ]);
          const { eq } = await import("drizzle-orm");
          await db.update(creditPacks).set({ is_active: true })
            .where(eq(creditPacks.stripe_price_id, "price_proof_medium"));
          process.exit(0);
          `,
        ],
        {
          env: childEnv(url),
          cwd: path.dirname(SCRIPT),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(reviver.exitCode).toBe(0);

      // Rollback to the original configuration: the run observes the row
      // active with a stale deactivated marker and must normalize it to
      // activated_out_of_band so a later archive cannot be defeated.
      const runA2 = runSeeder(url, ["--json"], FULL_PACK_ENV);
      expect(runA2.exitCode).toBe(0);
      const afterObservation = (await readRawRows(url)).find(
        (r) => r.stripe_price_id === "price_proof_medium",
      );
      expect(afterObservation?.is_active).toBe(true);
      expect(
        (
          (afterObservation?.metadata as Record<string, unknown>)
            ?.last_lifecycle_event as { kind?: unknown } | undefined
        )?.kind,
      ).toBe("activated_out_of_band");

      // Operator archives the pack. The normalized marker is NOT a repair
      // deactivation, so a rerun must leave the row archived.
      const archiver = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `
          const [{ db }, { creditPacks }] = await Promise.all([
            import("../../shared/src/db/client"),
            import("../../shared/src/db/schemas/credit-packs"),
          ]);
          const { eq } = await import("drizzle-orm");
          await db.update(creditPacks).set({ is_active: false })
            .where(eq(creditPacks.stripe_price_id, "price_proof_medium"));
          process.exit(0);
          `,
        ],
        {
          env: childEnv(url),
          cwd: path.dirname(SCRIPT),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(archiver.exitCode).toBe(0);

      const rerun = runSeeder(url, ["--json"], FULL_PACK_ENV);
      expect(rerun.exitCode).toBe(0);
      expect(JSON.parse(rerun.stdout).reactivated).toHaveLength(0);
      const finalRow = (await readRawRows(url)).find(
        (r) => r.stripe_price_id === "price_proof_medium",
      );
      expect(finalRow?.is_active).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);

  test("unobserved double-toggle is indistinguishable from repair deactivation (documented residual, #22963 review)", async () => {
    const { dir, url } = await freshDb();
    try {
      // A→B: repair deactivates price_proof_medium.
      const runA1 = runSeeder(url, ["--json"], FULL_PACK_ENV);
      expect(runA1.exitCode).toBe(0);
      const runB = runSeeder(url, ["--json"], {
        ...FULL_PACK_ENV,
        STRIPE_MEDIUM_PACK_PRICE_ID: "price_proof_rollback_medium",
        STRIPE_MEDIUM_PACK_PRODUCT_ID: "prod_proof_rollback_medium",
      });
      expect(runB.exitCode).toBe(0);

      // An operator toggles the row active then inactive with NO metadata
      // writes and NO intervening run. The resulting row state is byte-
      // identical to the repair-deactivated state, so no state-derived rule
      // can separate the two: the rollback run WILL reactivate. This test
      // pins the documented residual honestly instead of hiding it.
      const toggler = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `
          const [{ db }, { creditPacks }] = await Promise.all([
            import("../../shared/src/db/client"),
            import("../../shared/src/db/schemas/credit-packs"),
          ]);
          const { eq } = await import("drizzle-orm");
          const pid = "price_proof_medium";
          await db.update(creditPacks).set({ is_active: true }).where(eq(creditPacks.stripe_price_id, pid));
          await db.update(creditPacks).set({ is_active: false }).where(eq(creditPacks.stripe_price_id, pid));
          process.exit(0);
          `,
        ],
        {
          env: childEnv(url),
          cwd: path.dirname(SCRIPT),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(toggler.exitCode).toBe(0);

      const runA2 = runSeeder(url, ["--json"], FULL_PACK_ENV);
      expect(runA2.exitCode).toBe(0);
      expect(JSON.parse(runA2.stdout).reactivated).toHaveLength(1);
      const row = (await readRawRows(url)).find(
        (r) => r.stripe_price_id === "price_proof_medium",
      );
      expect(row?.is_active).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
