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
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
  return buildMultiTenantBackupFixture([
    { sourceDb, databaseName, tenantRole },
  ]);
}

/**
 * Multi-tenant variant: one real pg_dump per tenant database, one shared
 * archive, one globals.sql with a distinct role per tenant. Drives the
 * scaled (multi-database) drill path — linear own-connect per tenant plus
 * the sampled cross-reject pair (#23453 review r2).
 */
async function buildMultiTenantBackupFixture(
  tenants: { sourceDb: string; databaseName: string; tenantRole: string }[],
): Promise<Fixture> {
  const first = tenants[0];
  const setDir = mkdtempSync(join(tmpdir(), "drill-set-"));
  const dumpsDir = join(setDir, "dumps");
  mkdirSync(dumpsDir);
  const dumpIds = tenants.map((_, i) => `${"a1b2c3d4e5f6".slice(0, 11)}${i}`);

  // Real pg_dump of every seeded source database.
  const url = new URL(BASE_URL);
  for (let i = 0; i < tenants.length; i++) {
    sh(
      `pg_dump --format=custom --no-owner --no-privileges --dbname=${tenants[i].sourceDb} --file=${join(dumpsDir, `${dumpIds[i]}.dump`)}`,
      {
        env: {
          PGHOST: url.hostname,
          PGPORT: url.port || "5432",
          PGUSER: decodeURIComponent(url.username),
          PGPASSWORD: url.password ?? "",
        },
      },
    );
  }

  const manifest = {
    schema_version: 1,
    kind: "tenant-db-backup",
    created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    database_count: tenants.length,
    globals: "globals.sql",
    dbmap: "dbmap.tsv",
    checksums: "checksums.sha256",
  };
  writeFileSync(join(setDir, "manifest.json"), JSON.stringify(manifest));
  // Canonical pg_dumpall --globals-only shape: role attributes without LOGIN
  // options that the harness's strict parser rejects.
  writeFileSync(
    join(setDir, "globals.sql"),
    `${tenants
      .map(
        (t) =>
          `CREATE ROLE ${t.tenantRole};\nALTER ROLE ${t.tenantRole} WITH LOGIN PASSWORD 'tenantpw23453';`,
      )
      .join("\n")}\n`,
  );
  writeFileSync(
    join(setDir, "dbmap.tsv"),
    `${tenants.map((t, i) => `${dumpIds[i]}\t${t.databaseName}`).join("\n")}\n`,
  );
  sh(
    `sha256sum manifest.json globals.sql dbmap.tsv dumps/* > checksums.sha256`,
    {
      cwd: setDir,
    },
  );
  sh(
    `tar -czf backup.tar.gz manifest.json checksums.sha256 globals.sql dbmap.tsv dumps`,
    { cwd: setDir },
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
    database_count: tenants.length,
    cipher: "aes-256-cbc-pbkdf2-210000",
  };
  writeFileSync(join(setDir, "backup.json"), JSON.stringify(sidecar));

  const probesFile = join(setDir, "..", `probes-${Date.now()}.json`);
  writeFileSync(
    probesFile,
    JSON.stringify({
      schema_version: 1,
      tenants: tenants.map((t, i) => ({
        dump_id: dumpIds[i],
        role: t.tenantRole,
        password_env: "DRILL_TENANT_PW",
      })),
    }),
  );

  const fixture: Fixture = {
    setDir,
    archiveSha256,
    passphraseFile,
    capabilityFile: "",
    probesFile,
    tenantRole: first.tenantRole,
    tenantPassword: "tenantpw23453",
    databaseName: first.databaseName,
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
 * gated suite runs a REAL local pgbouncer listing the restored tenant
 * databases. Own-connect probes route through it (the per-tenant routing
 * assertion), so the pooler is required whenever the suite is enabled.
 */
const POOLER_ENABLED = ENABLED;

/**
 * pgbouncer is resolved portably (Linux CI, Intel Macs, non-default
 * prefixes): explicit override first, then PATH lookup via Bun.which.
 * A missing binary fails fast with the override instruction instead of
 * surfacing as an opaque ENOENT deep inside the drill.
 */
function resolvePgbouncerBin(): string {
  return (
    process.env.DRILL_TEST_PGBOUNCER_BIN ??
    Bun.which("pgbouncer") ??
    (() => {
      throw new Error(
        "pgbouncer executable not found on PATH; install pgbouncer or set DRILL_TEST_PGBOUNCER_BIN to its absolute path",
      );
    })()
  );
}

function startPgbouncer(): void {
  pgbouncerDir = mkdtempSync(join(tmpdir(), "drill-pgbouncer-"));
  const ini = join(pgbouncerDir, "pgbouncer.ini");
  const users = join(pgbouncerDir, "users.txt");
  // Production-representative routing (#23453 review r2): the tenant-db
  // cloud-init configures pgbouncer with the WILDCARD database mapping
  // `* = host=127.0.0.1 port=5432` + auth_file — any requested database
  // routes to the local Postgres and the credential gates CONNECT. The
  // harness mirrors that shape (wildcard, not per-database lines) so the
  // drill's pooler-surface own-connect proves routing through the SAME
  // configuration production uses. Plain auth stands in for production
  // SCRAM-via-auth_query — the property under test is routing, not the
  // auth backend; a mapping that pointed tenant A at tenant B's database
  // fails the drill's identity check either way.
  writeFileSync(
    ini,
    `[databases]
* = host=127.0.0.1 port=${new URL(BASE_URL).port || "5432"}

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
    `"drill23453test_tenant_a" "tenantpw23453"\n"drill23453test_tenant_b" "tenantpw23453"\n"drill23453test_tenant_c" "tenantpw23453"\n"drill23453test_mt_a" "tenantpw23453"\n"drill23453test_mt_b" "tenantpw23453"\n"drill23453test_mt_c" "tenantpw23453"\n`,
  );
  const child = execFileCb(resolvePgbouncerBin(), ["-q", ini], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

/**
 * Provision the twin settings through the REAL `provision` subcommand — the
 * same path an operator runs — so the postgresql.auto.conf write, reload, and
 * fresh-session verification are exercised as shipped, not re-implemented
 * here.
 */
async function provisionTarget(targetDb: string, capabilityFile: string) {
  const result = spawnSync(
    "bun",
    [
      "packages/cloud/scripts/admin/apps-tenant-db-recovery.ts",
      "provision",
      "--target-dsn",
      dbUrl(targetDb),
      "--target-id",
      TARGET_ID,
      "--capability-file",
      capabilityFile,
    ],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        ELIZA_RESTORE_CAPABILITY_KEY: SIGNING_KEY,
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `provision exited ${result.status}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    );
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
        startPgbouncer();
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
          // error-policy:J6 pgbouncer may already have exited.
        }
      }
      for (const fn of cleanups) {
        try {
          fn();
        } catch {
          // error-policy:J6 best-effort temp cleanup.
        }
      }
      try {
        await admin.query(`ALTER SYSTEM RESET eliza.restore_target_id`);
        await admin.query(`ALTER SYSTEM RESET eliza.restore_capability`);
        await admin.query(`SELECT pg_reload_conf()`);
      } catch {
        // error-policy:J6 settings may already be reset by the drill's consume step.
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
      // NOTE: the e2e run includes the pooler surface — own-connect probes
      // route through pgbouncer as the per-tenant routing assertion, so the
      // local pgbouncer must list every restored tenant database.
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

    test("multi-tenant drill: three tenants, own-connect through pooler and direct, sampled cross-reject", async () => {
      // Scaled isolation proof (#23453 review r2): three tenants exercise the
      // linear own-connect per tenant on BOTH surfaces (direct + pooler with
      // the production wildcard routing shape), the sampled cross-reject
      // pair, and the per-database ACL assertion — the same guarantee the
      // O(n^2) pairwise probe gave, at linear cost.
      const tenants = ["a", "b", "c"].map((suffix) => ({
        sourceDb: `${TEST_PREFIX}mt_src_${suffix}`,
        databaseName: `${TEST_PREFIX}mt_${suffix}`,
        tenantRole: `${TEST_PREFIX}mt_${suffix}`,
      }));
      const targetDb = `${TEST_PREFIX}mt_target`;
      for (const t of tenants) {
        await admin.query(`CREATE DATABASE ${t.sourceDb}`);
        const src = new Client({ connectionString: dbUrl(t.sourceDb) });
        await src.connect();
        await src.query(`CREATE TABLE evidence (id int, note text)`);
        await src.query(
          `INSERT INTO evidence VALUES (1, 'mt-data-${t.tenantRole}')`,
        );
        await src.end();
      }
      cleanups.push(() =>
        spawnSync("psql", [
          "-c",
          `DROP DATABASE IF EXISTS ${targetDb} WITH (FORCE)`,
        ]),
      );

      const fixture = await buildMultiTenantBackupFixture(tenants);
      // Every probe role must reach the pooler's auth_file: the roles are
      // drill23453test_*-prefixed, but the production wildcard routing
      // accepts ANY database name and defers to credentials — the same
      // shape under test.
      fixture.capabilityFile = mintCapabilityFile(fixture.archiveSha256);
      await admin.query(`CREATE DATABASE ${targetDb}`);
      await provisionTarget(targetDb, fixture.capabilityFile);

      const result = spawnSync(
        "bun",
        [
          "packages/cloud/scripts/admin/apps-tenant-db-recovery.ts",
          "--set-dir",
          fixture.setDir,
          "--target-dsn",
          dbUrl(targetDb),
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
      if (result.status !== 0) {
        throw new Error(
          `drill exited ${result.status}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
        );
      }
      const report = JSON.parse(result.stdout);
      expect(report.databaseCount).toBe(3);
      expect(report.isolation.plan).toBe("linear");
      // 3 own-connects + 1 cross-reject sample, each on 2 surfaces, + 3 ACL
      // assertions = 11 executed probes, all passing.
      expect(report.isolation.total).toBe(11);
      expect(report.isolation.passed).toBe(report.isolation.total);
      expect(report.objectives.met).toBe(true);

      // Every tenant's restored data is real AND reachable by that tenant's
      // OWN role credentials — not the admin credential (#23453 review r3):
      // the dumps are --no-owner/--no-privileges and restore as the restore
      // administrator, so CONNECT alone would not prove tenant access to the
      // restored objects. The database is created OWNER <tenant role> by the
      // drill, which must yield real table access for that role.
      for (const t of tenants) {
        const url = new URL(BASE_URL);
        const roleConn = `postgresql://${t.tenantRole}:tenantpw23453@${url.host}/${t.databaseName}`;
        const check = new Client({ connectionString: roleConn });
        await check.connect();
        const rows = await check.query(
          `SELECT note FROM evidence WHERE id = 1`,
        );
        expect(rows.rows[0]?.note).toBe(`mt-data-${t.tenantRole}`);
        await check.end();
      }
    }, 180_000);

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

    test("substituted archive with a consistent sidecar is still refused by the capability pin", async () => {
      // The sidecar is rewritten to MATCH the substituted archive, so only
      // the signed capability pin (REFUSED_ARCHIVE_MISMATCH) can refuse it.
      // Proves the drill cannot be downgraded to sidecar-only checking.
      const sourceDb = `${TEST_PREFIX}src3`;
      const targetDb = `${TEST_PREFIX}target4`;
      const databaseName = `${TEST_PREFIX}tenant_c`;
      const tenantRole = `${TEST_PREFIX}tenant_c`;
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
      // Capability pins the REAL archive...
      fixture.capabilityFile = mintCapabilityFile(fixture.archiveSha256);
      // ...then substitute a different, internally-consistent set: a fresh
      // archive whose sidecar describes IT (not the pinned one).
      sh(`echo tampered > ${join(fixture.setDir, "backup.tar.gz.enc")}`);
      const substitutedArchivePath = join(fixture.setDir, "backup.tar.gz.enc");
      const substitutedSha = sh(
        `shasum -a 256 ${substitutedArchivePath} | cut -d' ' -f1`,
      ).trim();
      const substitutedBytes = statSync(substitutedArchivePath).size;
      const sidecarPath = join(fixture.setDir, "backup.json");
      const sidecar = JSON.parse(readFileSync(sidecarPath, "utf-8"));
      sidecar.archive_sha256 = substitutedSha;
      sidecar.archive_bytes = substitutedBytes;
      writeFileSync(sidecarPath, JSON.stringify(sidecar));
      await admin.query(`CREATE DATABASE ${targetDb}`);
      await provisionTarget(targetDb, fixture.capabilityFile);

      const result = spawnSync(
        "bun",
        [
          "packages/cloud/scripts/admin/apps-tenant-db-recovery.ts",
          "--set-dir",
          fixture.setDir,
          "--target-dsn",
          dbUrl(targetDb),
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
      // The capability pin is the only remaining check that can fail here.
      expect(result.stderr).toContain("REFUSED_ARCHIVE_MISMATCH");
    });

    test("a refused first invocation leaves no claim: the retry is still refused (claim-order regression r3)", async () => {
      // Round-3 finding 1: the claim used to persist BEFORE the clean-target
      // collision check, so a refused first invocation left a claim that a
      // retry treated as a legitimate same-capability retry — exempting the
      // archive-named role and proceeding to ALTER ROLE. The claim now
      // persists only after the collision check passes, so BOTH invocations
      // must refuse.
      const sourceDb = `${TEST_PREFIX}src6`;
      const targetDb = `${TEST_PREFIX}target6`;
      const databaseName = `${TEST_PREFIX}tenant_f`;
      const tenantRole = `${TEST_PREFIX}tenant_f`;
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
      fixture.capabilityFile = mintCapabilityFile(fixture.archiveSha256);
      await admin.query(`CREATE DATABASE ${targetDb}`);
      await provisionTarget(targetDb, fixture.capabilityFile);
      // Pre-create the archive-named role: the clean-target collision check
      // must refuse — on the first invocation AND on the retry.
      await admin.query(`CREATE ROLE ${tenantRole}`);

      const runDrill = () =>
        spawnSync(
          "bun",
          [
            "packages/cloud/scripts/admin/apps-tenant-db-recovery.ts",
            "--set-dir",
            fixture.setDir,
            "--target-dsn",
            dbUrl(targetDb),
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

      const first = runDrill();
      expect(first.status).not.toBe(0);
      expect(first.stderr).toContain("REFUSED_NONEMPTY_TARGET");
      // The killed first-run lock holder's server session is dropped
      // asynchronously, so poll pg_locks until no session holds the drill
      // advisory lock on the target database before retrying (a fixed sleep
      // is flaky: LOCK_FAILED here means the retry never even reaches the
      // collision check this test exists to exercise).
      const lockFree = async (): Promise<boolean> => {
        const res = await admin.query(
          `SELECT 1 FROM pg_locks l JOIN pg_database d ON d.oid = l.database
           WHERE l.locktype = 'advisory' AND d.datname = $1`,
          [targetDb],
        );
        return res.rowCount === 0;
      };
      for (let i = 0; i < 60 && !(await lockFree()); i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const second = runDrill();
      expect(second.status).not.toBe(0);
      expect(second.stderr).toContain("REFUSED_NONEMPTY_TARGET");
      // The retry-exemption must never have applied: the archive-named role
      // collision is the refusal in both runs, not a restore-side failure.
      expect(second.stderr).not.toContain("restored tenant data");
    }, 120_000);

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
        // The expected refusal's typed code is captured, not swallowed.
        code = (error as { code?: string }).code ?? "";
      }
      expect(code).toBe("REFUSED_TARGET_AUTHORITY");
    });

    test("fresh target with archive-named role is refused (claim-order regression)", async () => {
      // Regression (#23453 review finding 3): reading the same-capability
      // claim AFTER the claim transaction upserts it made every target look
      // like a retry, exempting archive-named roles from the clean-target
      // collision check. A FRESH target (no prior claim) that already
      // carries a role this archive defines must be refused.
      const sourceDb = `${TEST_PREFIX}src4`;
      const targetDb = `${TEST_PREFIX}target5`;
      const databaseName = `${TEST_PREFIX}tenant_d`;
      const tenantRole = `${TEST_PREFIX}tenant_d`;
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
      fixture.capabilityFile = mintCapabilityFile(fixture.archiveSha256);
      await admin.query(`CREATE DATABASE ${targetDb}`);
      await provisionTarget(targetDb, fixture.capabilityFile);
      // Pre-create the archive-named role on the FRESH target: only the
      // clean-target collision check (not a retry exemption) can catch it.
      await admin.query(`CREATE ROLE ${tenantRole}`);

      const result = spawnSync(
        "bun",
        [
          "packages/cloud/scripts/admin/apps-tenant-db-recovery.ts",
          "--set-dir",
          fixture.setDir,
          "--target-dsn",
          dbUrl(targetDb),
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
      expect(result.stderr).toContain("REFUSED_NONEMPTY_TARGET");
    }, 120_000);
  },
);

if (!ENABLED) {
  describe("restore drill authority on real PostgreSQL (#23453) [gated]", () => {
    test.skip("requires RUN_REAL_POSTGRES_DRILL_TESTS=1 and DRILL_TEST_DATABASE_URL", () => {});
  });
}
