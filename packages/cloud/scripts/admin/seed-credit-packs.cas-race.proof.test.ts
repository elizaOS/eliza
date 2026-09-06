/**
 * Real-DB interleaving proof for the deactivation compare-and-set (#26599
 * review): the seeder and an operator writer attach to the SAME live PGlite
 * TCP socket server. The operator mutates a stale catalogue row AFTER the
 * seeder's snapshot read but BEFORE its deactivation update. The update must
 * match zero rows (lost race) — the operator's activation flip and metadata
 * rewrite survive byte-exactly, and the seeder reports a skipped row instead
 * of a "successful repair".
 *
 * The interleave is driven by a pause hook in seed-credit-packs.ts itself:
 * with ELIZA_TEST_CAS_PAUSE_DIR set, the seeder writes a marker file right
 * after the stale-catalogue SELECT (before any deactivation write) and waits
 * for it to disappear. Test-only, no effect on production runs.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = `${import.meta.dir}/seed-credit-packs.ts`;

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

/** Run one SQL statement as a one-shot pg client (the operator's channel). */
async function sql<T>(tcpUrl: string, query: string): Promise<T> {
  const proc = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `const { Client } = require(${JSON.stringify(
        path.resolve(import.meta.dir, "../../shared/node_modules/pg"),
      )});
       const c = new Client({ connectionString: ${JSON.stringify(tcpUrl)} });
       await c.connect();
       const r = await c.query(${JSON.stringify(query)});
       console.log(JSON.stringify(r.rows));
       await c.end();
       process.exit(0);`,
    ],
    {
      env: {
        ...childEnv(tcpUrl),
        NODE_PATH: path.resolve(import.meta.dir, "../../shared/node_modules"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (proc.exitCode !== 0) {
    throw new Error(`sql failed: ${proc.stderr.toString().slice(-400)}`);
  }
  return JSON.parse(proc.stdout.toString()) as T;
}

describe("seed-credit-packs deactivation CAS under a concurrent operator write (#26599)", () => {
  test("a stale-row deactivation that loses the read-modify-write race is skipped, not forced", async () => {
    const serverDataDir = await mkdtemp(`${tmpdir()}/22963-cas-`);
    const pauseDir = await mkdtemp(`${tmpdir()}/22963-cas-pause-`);
    const port = 5543 + (process.pid % 1000);
    const tcpUrl = `postgresql://postgres@127.0.0.1:${port}/postgres`;

    const server = Bun.spawn(
      [process.execPath, `${import.meta.dir}/dev/pglite-server.ts`],
      {
        env: {
          ...childEnv(tcpUrl),
          PGLITE_PORT: String(port),
          PGLITE_HOST: "127.0.0.1",
          PGLITE_DATA_DIR: serverDataDir,
        },
        cwd: path.dirname(SCRIPT),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      // Bounded wait for the TCP server to accept a raw socket.
      let up = false;
      for (let i = 0; i < 60 && !up; i++) {
        const probe = Bun.spawnSync(
          [
            process.execPath,
            "-e",
            `const net = require("node:net");
             const s = net.connect(${port}, "127.0.0.1");
             s.on("connect", () => { s.destroy(); process.exit(0); });
             s.on("error", () => { s.destroy(); process.exit(1); });
             setTimeout(() => process.exit(2), 900);`,
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        up = probe.exitCode === 0;
        if (!up) await new Promise((r) => setTimeout(r, 500));
      }
      expect(up).toBe(true);

      // Real migration journal over the TCP backend.
      const migrate = Bun.spawnSync([process.execPath, "run", "db:migrate"], {
        cwd: `${import.meta.dir}/../../shared`,
        env: childEnv(tcpUrl),
        stdout: "pipe",
        stderr: "pipe",
      });
      if (migrate.exitCode !== 0) {
        throw new Error(
          `migrate failed: ${migrate.stderr.toString().slice(-400)}`,
        );
      }

      // The racing row: ACTIVE, carrying the repair stamp (drift shape that
      // routes through the hasRepairStamp deactivation branch), price id NOT
      // in the configured env — it is stale the moment the seeder reads it.
      await sql(
        tcpUrl,
        `INSERT INTO credit_packs
           (name, description, credits, price_cents, stripe_price_id,
            stripe_product_id, is_active, sort_order, metadata)
         VALUES
           ('Race Row', 'cas interleave', '5.00', 4999, 'price_case_race',
            'prod_case_race', true, 10,
            '{"deprecation_stamps":[{"reason":"stripe_price_id_no_longer_configured","at":"2020-01-01T00:00:00.000Z"}]}'::jsonb)`,
      );

      // Start the seeder paused after its catalogue snapshot.
      const pauseMarker = path.join(pauseDir, "paused");
      const seeder = Bun.spawn([process.execPath, SCRIPT, "--json"], {
        env: childEnv(tcpUrl, {
          ...FULL_PACK_ENV,
          ELIZA_TEST_CAS_PAUSE_DIR: pauseDir,
        }),
        cwd: path.dirname(SCRIPT),
        stdout: "pipe",
        stderr: "pipe",
      });

      // Wait until the seeder holds its snapshot (marker exists).
      let paused = false;
      for (let i = 0; i < 120 && !paused; i++) {
        paused = existsSync(pauseMarker);
        if (!paused) await new Promise((r) => setTimeout(r, 500));
      }
      expect(paused).toBe(true);

      // The operator's competing write lands INSIDE the seeder's
      // read→update window: activation kept + metadata replaced.
      await sql(
        tcpUrl,
        `UPDATE credit_packs
            SET is_active = true,
                metadata = '{"operator_note":"kept-live-by-operator"}'::jsonb
          WHERE stripe_price_id = 'price_case_race'`,
      );

      // Release the seeder.
      await unlink(pauseMarker);
      const seederOut = await new Response(seeder.stdout).text();
      const seederCode = await seeder.exited;
      expect(seederCode).toBe(0);

      const seederJson = JSON.parse(seederOut);
      // Lost race is NOT a successful repair: the row is absent from the
      // deprecated report (reported by pack id, not price id).
      const raceRowId = (
        await sql<Array<{ id: string }>>(
          tcpUrl,
          "SELECT id FROM credit_packs WHERE stripe_price_id = 'price_case_race'",
        )
      )[0]?.id;
      expect(raceRowId).toBeDefined();
      expect(seederJson.deprecated).not.toContain(raceRowId);

      // The operator's change survived byte-exactly — no deactivation stamp,
      // no lifecycle event, activation intact, metadata exactly as written.
      const rows = await sql<Array<{ is_active: boolean; metadata: unknown }>>(
        tcpUrl,
        "SELECT is_active, metadata FROM credit_packs WHERE stripe_price_id = 'price_case_race'",
      );
      expect(rows[0]?.is_active).toBe(true);
      expect(rows[0]?.metadata).toEqual({
        operator_note: "kept-live-by-operator",
      });
    } finally {
      server.kill("SIGTERM");
      await server.exited.catch(() => {});
      await rm(serverDataDir, { recursive: true, force: true });
      await rm(pauseDir, { recursive: true, force: true });
    }
  }, 240_000);
});
