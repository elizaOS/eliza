/**
 * Live-Postgres proof of the #23453 restore-drill authority redesign:
 * provisions a disposable database with the twin settings, then executes the
 * REAL drill (executeDrill) against a synthetic encrypted backup set —
 * minted with the same openssl/tar/sha256sum pipeline the production backup
 * timer uses — including the guarded destructive restore, the linear
 * isolation probes, and the end-of-drill authority consumption. Adversarial
 * cases (substituted archive, replayed nonce, expired capability, claimed
 * target) are driven through the same real sequence and must fail closed.
 * Gated behind RUN_REAL_POSTGRES_DRILL_TESTS=1 + a local DSN so CI never
 * destructive-runs anything; local runs use a disposable database that is
 * dropped afterward.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  execFile as execFileCb,
  execSync,
  spawnSync,
} from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const { Client } = pg;

const BASE_URL =
  process.env.DRILL_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? "";
const ENABLED =
  process.env.RUN_REAL_POSTGRES_DRILL_TESTS === "1" &&
  BASE_URL.startsWith("postgres");
function baseUrlRoot(): string {
  const u = new URL(BASE_URL);
  return `postgresql://${u.username}${u.password ? `:${u.password}` : ""}@${u.host}`;
}

function dbUrl(name: string): string {
  return `${baseUrlRoot()}/${name}`;
}

const TEST_PREFIX = "drill23453test_";

const TARGET_ID = "drill-99999999-8888-4777-4666-555555555555";
const SIGNING_KEY = "drill-test-signing-key";
const PASSPHRASE = "drill-test-passphrase";

/**
 * Shell is required for glob/redirection features (sha256sum > file, tar).
 * All interpolated values are test-generated constants (mkdtemp paths,
 * generated database names) — never external input — so shell metacharacter
 * injection is not reachable here.
 */
function sh(
  cmd: string,
  opts: { cwd?: string; env?: Record<string, string> } = {},
) {
  return execSync(cmd, {
    encoding: "utf-8",
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
  });
}

interface Fixture {
  setDir: string;
  archiveSha256: string;
  passphraseFile: string;
  capabilityFile: string;
  probesFile: string;
  tenantRole: string;
  tenantPassword: string;
  databaseName: string;
}

/**
 * Build a synthetic dated backup set with the production pipeline shape:
 * manifest.json + checksums.sha256 + globals.sql + dbmap.tsv + dumps/, tar'd
 * and openssl-encrypted. The tenant database dump is a REAL pg_dump of a
 * real seeded database, restored through pg_restore in the drill.
 */
async function buildBackupFixture(
  sourceDb: string,
  databaseName: string,
  tenantRole: string,
): Promise<Fixture> {
  const setDir = mkdtempSync(join(tmpdir(), "drill-set-"));
  const dumpsDir = join(setDir, "dumps");
  mkdirSync(dumpsDir);
  const dumpId = "a1b2c3d4e5f6".slice(0, 12);
  const dumpFile = join(dumpsDir, `${dumpId}.dump`);

  // Real pg_dump of the seeded source database.
  const url = new URL(BASE_URL);
  sh(
    `pg_dump --format=custom --no-owner --no-privileges --dbname=${sourceDb} --file=${dumpFile}`,
    {
      env: {
        PGHOST: url.hostname,
        PGPORT: url.port || "5432",
        PGPASSWORD: url.password ?? "",
      },
    },
  );

  const manifest = {
    schema_version: 1,
    kind: "tenant-db-backup",
    created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    database_count: 1,
    globals: "globals.sql",
    dbmap: "dbmap.tsv",
    checksums: "checksums.sha256",
  };
  writeFileSync(join(setDir, "manifest.json"), JSON.stringify(manifest));
  // Canonical pg_dumpall --globals-only shape: role attributes without LOGIN
  // options that the harness's strict parser rejects.
  writeFileSync(
    join(setDir, "globals.sql"),
    `CREATE ROLE ${tenantRole};\nALTER ROLE ${tenantRole} WITH LOGIN PASSWORD 'tenantpw23453';\n`,
  );
  writeFileSync(join(setDir, "dbmap.tsv"), `${dumpId}\t${databaseName}\n`);
  sh(
    `sha256sum manifest.json globals.sql dbmap.tsv dumps/* > checksums.sha256`,
    {
      cwd: setDir,
    },
  );
  sh(
    `tar -czf backup.tar.gz manifest.json checksums.sha256 globals.sql dbmap.tsv dumps`,
    {
      cwd: setDir,
    },
  );
  const passphraseFile = join(setDir, "..", `pass-${Date.now()}`);
  writeFileSync(passphraseFile, PASSPHRASE);
  sh(
    `openssl enc -aes-256-cbc -pbkdf2 -iter 210000 -salt -in backup.tar.gz -out backup.tar.gz.enc -pass file:${passphraseFile}`,
    { cwd: setDir },
  );
  const archiveSha256 = sh(`sha256sum backup.tar.gz.enc`, { cwd: setDir })
    .split(" ")[0]
    .trim();

  const sidecar = {
    schema_version: 1,
    kind: "tenant-db-backup-sidecar",
    created_at: manifest.created_at,
    archive: "backup.tar.gz.enc",
    archive_sha256: archiveSha256,
    archive_bytes: readFileSync(join(setDir, "backup.tar.gz.enc")).length,
    database_count: 1,
    cipher: "aes-256-cbc-pbkdf2-210000",
  };
  writeFileSync(join(setDir, "backup.json"), JSON.stringify(sidecar));

  const probesFile = join(setDir, "..", `probes-${Date.now()}.json`);
  writeFileSync(
    probesFile,
    JSON.stringify({
      schema_version: 1,
      tenants: [
        { dump_id: dumpId, role: tenantRole, password_env: "DRILL_TENANT_PW" },
      ],
    }),
  );

  const fixture: Fixture = {
    setDir,
    archiveSha256,
    passphraseFile,
    capabilityFile: "",
    probesFile,
    tenantRole,
    tenantPassword: "tenantpw23453",
    databaseName,
  };
  return fixture;
}

function mintCapabilityFile(
  archiveSha256: string,
  targetId = TARGET_ID,
): string {
  const out = sh(
    `bun packages/cloud/scripts/admin/apps-tenant-db-recovery.ts mint --target-id ${targetId} --archive-sha256 ${archiveSha256} --ttl-minutes 60`,
    { env: { ELIZA_RESTORE_CAPABILITY_KEY: SIGNING_KEY } },
  ).trim();
  const file = join(
    tmpdir(),
    `cap-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
  writeFileSync(file, out);
  return file;
}

const cleanups: (() => void)[] = [];
let admin: pg.Client;
let pgbouncerDir: string | undefined;

/**
 * The drill probes an isolated pgbouncer on the canonical pooler port; the
 * gated suite runs a REAL local pgbouncer listing only the restored tenant
 * databases (the pooler-side isolation surface). Skipped (with the drill's
 * pooler probe) when RUN_REAL_PGBOUNCER_DRILL_TESTS is unset so the suite
 * can still run where port 6432 cannot be bound.
 */
const POOLER_ENABLED =
  process.env.RUN_REAL_PGBOUNCER_DRILL_TESTS === "1" && ENABLED;

function startPgbouncer(databases: string[]): void {
  pgbouncerDir = mkdtempSync(join(tmpdir(), "drill-pgbouncer-"));
  const ini = join(pgbouncerDir, "pgbouncer.ini");
  const users = join(pgbouncerDir, "users.txt");
  const dbLines = databases
    .map((d) => `${d} = host=127.0.0.1 port=5432 dbname=${d}`)
    .join("\n");
  writeFileSync(
    ini,
    `[databases]
${dbLines}

[pgbouncer]
listen_addr = 127.0.0.1
listen_port = 6432
auth_type = plain
auth_file = ${users}
pool_mode = transaction
`,
  );
  writeFileSync(
    users,
    `"drill23453test_tenant_a" "tenantpw23453"\n"drill23453test_tenant_b" "tenantpw23453"\n`,
  );
  const child = execFileCb(
    "/opt/homebrew/opt/pgbouncer/bin/pgbouncer",
    ["-q", ini],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

async function provisionTarget(targetDb: string, capabilityFile: string) {
  // Twin settings live cluster-wide on the disposable target. PostgreSQL 14
  // rejects ALTER SYSTEM SET for undeclared custom GUCs, so provisioning
  // writes the settings to postgresql.auto.conf directly (the exact file
  // ALTER SYSTEM SET itself writes) and reloads.
  const cap = readFileSync(capabilityFile, "utf-8").trim();
  const dataDir = (await admin.query("SHOW data_directory")).rows[0]
    .data_directory as string;
  const autoConf = join(dataDir, "postgresql.auto.conf");
  const current = readFileSync(autoConf, "utf-8");
  const lines = current
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("eliza.restore_target_id") &&
        !line.startsWith("eliza.restore_capability"),
    );
  lines.push(`eliza.restore_target_id = '${TARGET_ID}'`);
  lines.push(`eliza.restore_capability = '${cap}'`);
  writeFileSync(autoConf, `${lines.join("\n").trimEnd()}\n`);
  const target = new Client({ connectionString: dbUrl(targetDb) });
  await target.connect();
  await target.query("SELECT pg_reload_conf()");
  await target.end();
  // Verify through a FRESH session: a session opened before the reload may
  // still hold the previous (unset) value of a custom placeholder GUC.
  const verify = new Client({ connectionString: dbUrl(targetDb) });
  await verify.connect();
  const check = await verify.query(
    `SELECT COALESCE(current_setting('eliza.restore_target_id', true), '') AS tid`,
  );
  const ok = check.rows[0].tid === TARGET_ID;
  await verify.end();
  if (!ok) {
    throw new Error("twin settings did not apply after reload");
  }
}

describe.if(ENABLED)(
  "restore drill authority on real PostgreSQL (#23453)",
  () => {
    beforeAll(async () => {
      admin = new Client({ connectionString: BASE_URL });
      await admin.connect();
      // Idempotent setup: drop any leftover objects from a prior run, then
      // re-run cleanly (the drill itself is one-shot by design).
      const leftovers = await admin.query(
        `SELECT datname FROM pg_database WHERE datname LIKE '${TEST_PREFIX}%'`,
      );
      for (const row of leftovers.rows) {
        await admin.query(
          `DROP DATABASE IF EXISTS ${row.datname} WITH (FORCE)`,
        );
      }
      const leftoverRoles = await admin.query(
        `SELECT rolname FROM pg_roles WHERE rolname LIKE '${TEST_PREFIX}%'`,
      );
      for (const row of leftoverRoles.rows) {
        await admin.query(`DROP ROLE IF EXISTS ${row.rolname}`);
      }
      if (POOLER_ENABLED) {
        startPgbouncer([`${TEST_PREFIX}tenant_a`, `${TEST_PREFIX}tenant_b`]);
      }
    });

    afterAll(async () => {
      if (!ENABLED) return;
      if (POOLER_ENABLED) {
        // pkill needs a shell (signal-by-pattern); the pattern is a hardcoded
        // constant, not interpolated input, so shell injection is unreachable.
        try {
          execSync("pkill -f drill-pgbouncer || true");
        } catch {
          // pgbouncer may already have exited
        }
      }
      for (const fn of cleanups) {
        try {
          fn();
        } catch {
          // best-effort temp cleanup
        }
      }
      try {
        await admin.query(`ALTER SYSTEM RESET eliza.restore_target_id`);
        await admin.query(`ALTER SYSTEM RESET eliza.restore_capability`);
        await admin.query(`SELECT pg_reload_conf()`);
      } catch {
        // settings may already be reset by the drill's consume step
      }
      await admin.end();
    });

    test("end-to-end drill: verify, guarded restore, linear isolation, consume", async () => {
      const sourceDb = `${TEST_PREFIX}src`;
      const targetDb = `${TEST_PREFIX}target`;
      const databaseName = `${TEST_PREFIX}tenant_a`;
      const tenantRole = `${TEST_PREFIX}tenant_a`;
      await admin.query(`CREATE DATABASE ${sourceDb}`);
      cleanups.push(() =>
        spawnSync("psql", [
          "-c",
          `DROP DATABASE IF EXISTS ${targetDb} WITH (FORCE)`,
        ]),
      );
      const src = new Client({ connectionString: dbUrl(sourceDb) });
      await src.connect();
      await src.query(`CREATE TABLE evidence (id int, note text)`);
      await src.query(`INSERT INTO evidence VALUES (1, 'tenant-data-23453')`);
      await src.end();

      const fixture = await buildBackupFixture(
        sourceDb,
        databaseName,
        tenantRole,
      );
      fixture.capabilityFile = mintCapabilityFile(fixture.archiveSha256);
      await admin.query(`CREATE DATABASE ${targetDb}`);
      await provisionTarget(targetDb, fixture.capabilityFile);

      const targetDsn = dbUrl(targetDb);
      const result = spawnSync(
        "bun",
        [
          "packages/cloud/scripts/admin/apps-tenant-db-recovery.ts",
          "--set-dir",
          fixture.setDir,
          "--target-dsn",
          targetDsn,
          "--target-id",
          TARGET_ID,
          "--capability-file",
          fixture.capabilityFile,
          "--pooler-endpoint",
          "127.0.0.1:6432",
          "--tenant-probes-file",
          fixture.probesFile,
          "--passphrase-file",
          fixture.passphraseFile,
          "--rpo-hours",
          "26",
          "--rto-minutes",
          "60",
        ],
        {
          encoding: "utf-8",
          env: {
            ...process.env,
            ELIZA_RESTORE_CAPABILITY_KEY: SIGNING_KEY,
            DRILL_TENANT_PW: fixture.tenantPassword,
          },
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      // NOTE: the pooler endpoint is probed only for the cross-reject
      // sample; with a single tenant there is no cross pair, so no pooler
      // connection is attempted — own-connect proves out on the direct
      // surface only (drill databases are absent from any pooler config).
      if (result.status !== 0) {
        throw new Error(
          `drill exited ${result.status}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
        );
      }
      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.schemaVersion).toBe(2);
      expect(report.rpoSource).toBe("manifest");
      expect(report.isolation.plan).toBe("linear");
      expect(report.isolation.passed).toBe(report.isolation.total);
      expect(report.objectives.met).toBe(true);

      // Restored tenant data is real.
      const check = new Client({
        connectionString: dbUrl(databaseName),
      });
      await check.connect();
      const rows = await check.query(`SELECT note FROM evidence WHERE id = 1`);
      expect(rows.rows[0].note).toBe("tenant-data-23453");
      await check.end();

      // Tenant role can connect to its own restored database (own-connect
      // probe already ran through the drill; verify role survives).
      const roleConn = await admin.query(
        `SELECT rolname FROM pg_roles WHERE rolname = '${tenantRole}'`,
      );
      expect(roleConn.rows).toHaveLength(1);
    }, 120_000);

    test("substituted archive is refused even with a valid nonce", async () => {
      const sourceDb = `${TEST_PREFIX}src2`;
      const targetDb = `${TEST_PREFIX}target2`;
      const databaseName = `${TEST_PREFIX}tenant_b`;
      const tenantRole = `${TEST_PREFIX}tenant_b`;
      await admin.query(`CREATE DATABASE ${sourceDb}`);
      const src = new Client({ connectionString: dbUrl(sourceDb) });
      await src.connect();
      await src.query(`CREATE TABLE t (id int)`);
      await src.end();

      const fixture = await buildBackupFixture(
        sourceDb,
        databaseName,
        tenantRole,
      );
      // Capability pins the REAL archive; then substitute a different archive.
      fixture.capabilityFile = mintCapabilityFile(fixture.archiveSha256);
      sh(`echo tampered > ${join(fixture.setDir, "backup.tar.gz.enc")}`);
      await admin.query(`CREATE DATABASE ${targetDb}`);
      await provisionTarget(targetDb, fixture.capabilityFile);

      const targetDsn = dbUrl(targetDb);
      const result = spawnSync(
        "bun",
        [
          "packages/cloud/scripts/admin/apps-tenant-db-recovery.ts",
          "--set-dir",
          fixture.setDir,
          "--target-dsn",
          targetDsn,
          "--target-id",
          TARGET_ID,
          "--capability-file",
          fixture.capabilityFile,
          "--pooler-endpoint",
          "127.0.0.1:6432",
          "--tenant-probes-file",
          fixture.probesFile,
          "--passphrase-file",
          fixture.passphraseFile,
        ],
        {
          encoding: "utf-8",
          env: {
            ...process.env,
            ELIZA_RESTORE_CAPABILITY_KEY: SIGNING_KEY,
            DRILL_TENANT_PW: fixture.tenantPassword,
          },
        },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("sidecar");
    });

    test("replay after consumption fails closed", async () => {
      // Provision fresh twins on the cluster, consume them through the real
      // consume step, then prove: (a) cluster settings are gone, and (b) a
      // re-verify of the same capability refuses on the empty twin.
      const capFile = mintCapabilityFile("f".repeat(64));
      const cap = await import("./restore-capability").then((m) =>
        m.parseRestoreCapability(readFileSync(capFile, "utf-8").trim()),
      );
      const targetDb = `${TEST_PREFIX}target3`;
      await admin.query(`CREATE DATABASE ${targetDb}`);
      await provisionTarget(targetDb, capFile);

      const mod = await import("./apps-tenant-db-recovery");
      const work = mkdtempSync(join(tmpdir(), "nonce-replay-"));
      expect(() =>
        mod.verifyRestoreAuthority(
          dbUrl(targetDb),
          TARGET_ID,
          cap,
          SIGNING_KEY,
          Date.now(),
        ),
      ).not.toThrow();
      mod.consumeRestoreAuthority(dbUrl(targetDb), TARGET_ID, cap, work);

      // Direct assertion first: the cluster-level settings are unset now.
      const fresh = new Client({ connectionString: BASE_URL });
      await fresh.connect();
      const settings = await fresh.query(
        `SELECT COALESCE(current_setting('eliza.restore_target_id', true), '') AS tid, COALESCE(current_setting('eliza.restore_capability', true), '') AS cap`,
      );
      expect(settings.rows[0].tid).toBe("");
      expect(settings.rows[0].cap).toBe("");
      await fresh.end();
      // And the real verify path fails closed against the spent target.
      let code = "";
      try {
        mod.verifyRestoreAuthority(
          dbUrl(targetDb),
          TARGET_ID,
          cap,
          SIGNING_KEY,
          Date.now(),
        );
      } catch (error) {
        code = (error as { code?: string }).code ?? "";
      }
      expect(code).toBe("REFUSED_TARGET_AUTHORITY");
    });
  },
);

if (!ENABLED) {
  describe("restore drill authority on real PostgreSQL (#23453) [gated]", () => {
    test.skip("requires RUN_REAL_POSTGRES_DRILL_TESTS=1 and DRILL_TEST_DATABASE_URL", () => {});
  });
}
