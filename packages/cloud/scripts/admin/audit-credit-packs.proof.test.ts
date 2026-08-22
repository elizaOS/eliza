/**
 * Proof harness for audit-credit-packs.ts (#22963): applies the real migration
 * journal to a temp PGlite store, seeds packs via a SUBPROCESS (fresh module
 * cache per store — the in-process client is cached across tests), and runs
 * the audit as a subprocess with a hermetic environment.
 * Run: bun test packages/cloud/scripts/admin/audit-credit-packs.proof.test.ts
 *
 * Every test sets an explicit 60s timeout: freshDb/seed/audit spawn cold bun
 * subprocesses that exceeded bun's 5s default on hosted runners (#23870 CI
 * failures at ~5005ms). bunfig's [test] section has no timeout option (Bun
 * ignores the key — oven-sh/bun#7789), so the timeout stays per-test.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = `${import.meta.dir}/audit-credit-packs.ts`;
const SEED_HELPER = `${import.meta.dir}/audit-credit-packs.seed.ts`;

/** Hermetic child env: no inherited .env, keys stripped. */
function childEnv(dbUrl: string, extra: Record<string, string> = {}) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    DATABASE_URL: dbUrl,
    DISABLE_LOCAL_PGLITE_FALLBACK: "1",
    ...extra,
  };
}

async function freshDb(): Promise<{ dir: string; url: string }> {
  const dir = await mkdtemp(`${tmpdir()}/22963-audit-`);
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

/** Seed in a fresh process so the db client binds to THIS test's store. */
async function seed(url: string, rows: Array<Record<string, unknown>>) {
  const file = path.join(await mkdtemp(`${tmpdir()}/22963-seed-`), "rows.json");
  await writeFile(file, JSON.stringify(rows));
  const proc = Bun.spawnSync([process.execPath, SEED_HELPER, url, file], {
    env: childEnv(url),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`seed failed: ${proc.stderr.toString().slice(-400)}`);
  }
}

function runAudit(env: Record<string, string>, cwd: string) {
  const out = Bun.spawnSync([process.execPath, SCRIPT, "--json"], {
    env,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: out.exitCode, stdout: out.stdout.toString() };
}

describe("audit-credit-packs classification (#22963)", () => {
  test("empty catalogue: clean summary, empty packs array", async () => {
    const { dir, url } = await freshDb();
    try {
      const r = runAudit(childEnv(url), dir);
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.packs).toEqual([]);
      expect(parsed.summary).toBe("No credit packs exist in the database.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("no Stripe key: DB-active => UNKNOWN (not ERRONEOUS), DB-inactive => DEPRECATED", async () => {
    const { dir, url } = await freshDb();
    try {
      await seed(url, [
        {
          name: "Small Pack",
          credits: "5.00",
          price_cents: 4999,
          stripe_price_id: "price_a",
          stripe_product_id: "prod_a",
          is_active: true,
          sort_order: 1,
        },
        {
          name: "Medium Pack",
          credits: "15.00",
          price_cents: 12999,
          stripe_price_id: "price_b",
          stripe_product_id: "prod_b",
          is_active: false,
          sort_order: 2,
        },
      ]);
      const r = runAudit(childEnv(url), dir);
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout);
      const small = parsed.packs.find(
        (p: { name: string }) => p.name === "Small Pack",
      );
      const medium = parsed.packs.find(
        (p: { name: string }) => p.name === "Medium Pack",
      );
      expect(small.classification).toBe("UNKNOWN");
      expect(small.reasons.join(" ")).toContain("unverifiable");
      expect(medium.classification).toBe("DEPRECATED");
      // Economics is a NOTE (AC2 decision), never a classification override.
      expect(small.economicsNote).toContain("product approval");
      expect(small.impliedUsdPerCredit).toBeCloseTo(9.998, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("deployment currency guard: non-USD STRIPE_CURRENCY => ERRONEOUS", async () => {
    const { dir, url } = await freshDb();
    try {
      await seed(url, [
        {
          name: "Small Pack",
          credits: "5.00",
          price_cents: 4999,
          stripe_price_id: "price_a",
          stripe_product_id: "prod_a",
          is_active: true,
          sort_order: 1,
        },
      ]);
      const r = runAudit(childEnv(url, { STRIPE_CURRENCY: "eur" }), dir);
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.packs[0].classification).toBe("ERRONEOUS");
      expect(parsed.packs[0].reasons.join(" ")).toContain(
        "deployment currency guard",
      );
      expect(parsed.summary.deploymentCurrencyUsd).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("deployment currency guard sticks: non-USD + DB-inactive stays ERRONEOUS (not overwritten)", async () => {
    const { dir, url } = await freshDb();
    try {
      await seed(url, [
        {
          name: "Medium Pack",
          credits: "15.00",
          price_cents: 12999,
          stripe_price_id: "price_b",
          stripe_product_id: "prod_b",
          is_active: false,
          sort_order: 2,
        },
      ]);
      const r = runAudit(childEnv(url, { STRIPE_CURRENCY: "eur" }), dir);
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.packs[0].classification).toBe("ERRONEOUS");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("seededWiringMatches is null when the seeder env var is unset", async () => {
    const { dir, url } = await freshDb();
    try {
      await seed(url, [
        {
          name: "Small Pack",
          credits: "5.00",
          price_cents: 4999,
          stripe_price_id: "price_a",
          stripe_product_id: "prod_a",
          is_active: false,
          sort_order: 1,
        },
      ]);
      const r = runAudit(childEnv(url), dir);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.packs[0].seededWiringMatches).toBeNull();
      expect(parsed.packs[0].classification).toBe("DEPRECATED");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
