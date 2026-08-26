/**
 * Deterministic unit coverage for the tenant-DB restore-drill harness
 * (#21729): metadata parsing, checksum verification against real files on
 * disk, DSN redaction, isolated-target refusal, isolation-check planning, and
 * RPO/RTO evaluation. No Postgres or object storage involved — the live drill
 * path is exercised by operators against a real isolated instance.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertChecksumCoverage,
  assertDirectTarget,
  assertNoGlobalRoleCollisions,
  assertProbesCoverArchiveRoles,
  assertRestoreTargetIdentity,
  buildClaimExclusivitySql,
  buildIsolationChecks,
  evaluateObjectives,
  executeDrill,
  guardedConsumeAuthoritySql,
  guardPsqlScript,
  isCrossTenantDenial,
  makeGlobalsIdempotent,
  parseBackupManifest,
  parseBackupSidecar,
  parseChecksumFile,
  parseCliArgs,
  parseDbMap,
  parseGlobalRoleNames,
  parsePoolerEndpoint,
  parseRestoreTargetAuthority,
  parseTenantProbes,
  quoteSqlIdentifier,
  RecoveryDrillError,
  redactDsn,
  targetDatabaseDsn,
  verifyChecksums,
} from "./apps-tenant-db-recovery";
import {
  assertRecoveryPointConsistency,
  MAX_CAPABILITY_TTL_MS,
  mintRestoreCapability,
  parseRestoreCapability,
  serializeRestoreCapability,
  verifyRestoreCapability,
} from "./restore-capability";

const SIDECAR = {
  schema_version: 1,
  kind: "tenant-db-backup-sidecar",
  created_at: "2026-08-20T02:20:00Z",
  archive: "backup.tar.gz.enc",
  archive_sha256: "a".repeat(64),
  archive_bytes: 1234,
  database_count: 3,
  cipher: "aes-256-cbc-pbkdf2-210000",
};

describe("restore drill authority gating", () => {
  test("execution requires a capability before any destructive collaborator runs", () => {
    // No signing key in the environment: the drill refuses before touching
    // psql or reading any file — the #23482 unconditional disable is gone;
    // authority is now capability-gated instead of disabled outright.
    expect(() => executeDrill({} as never)).toThrow(
      expect.objectContaining({ code: "MISSING_SIGNING_KEY" }),
    );
  });
});

describe("redactDsn", () => {
  test("strips credentials and database, keeps host and port", () => {
    expect(
      redactDsn("postgresql://postgres:s3cret@10.30.1.10:5432/tenant_abc"),
    ).toBe("postgresql://<redacted>@10.30.1.10:5432/<db>");
  });

  test("never echoes an unparseable DSN", () => {
    expect(redactDsn("not a dsn with s3cret")).toBe("<invalid-dsn>");
  });
});

describe("parseBackupSidecar", () => {
  test("accepts a well-formed sidecar", () => {
    const sidecar = parseBackupSidecar(JSON.stringify(SIDECAR));
    expect(sidecar.databaseCount).toBe(3);
    expect(sidecar.archiveSha256).toBe("a".repeat(64));
    expect(sidecar.createdAt.toISOString()).toBe("2026-08-20T02:20:00.000Z");
  });

  test.each([
    ["not json", "{nope"],
    ["wrong kind", JSON.stringify({ ...SIDECAR, kind: "other" })],
    ["bad sha", JSON.stringify({ ...SIDECAR, archive_sha256: "xyz" })],
    ["negative bytes", JSON.stringify({ ...SIDECAR, archive_bytes: -1 })],
    ["bad date", JSON.stringify({ ...SIDECAR, created_at: "yesterday-ish" })],
  ])("rejects %s", (_label, json) => {
    expect(() => parseBackupSidecar(json)).toThrow(RecoveryDrillError);
  });
});

describe("parseBackupManifest", () => {
  test("accepts a well-formed manifest and rejects a foreign kind", () => {
    const manifest = parseBackupManifest(
      JSON.stringify({
        schema_version: 1,
        kind: "tenant-db-backup",
        created_at: "2026-08-20T02:16:00Z",
        database_count: 3,
      }),
    );
    expect(manifest.databaseCount).toBe(3);
    expect(() =>
      parseBackupManifest(
        JSON.stringify({
          schema_version: 2,
          kind: "tenant-db-backup",
          created_at: "2026-08-20T02:16:00Z",
          database_count: 3,
        }),
      ),
    ).toThrow(RecoveryDrillError);
  });
});

describe("restore target authority", () => {
  const targetId = "drill-11111111-2222-4333-8444-555555555555";

  test("accepts direct DSN shapes without treating the hostname as authority", () => {
    for (const host of ["127.0.0.1", "restore.internal", "10.30.1.10"]) {
      expect(() =>
        assertDirectTarget(`postgresql://postgres:pw@${host}:5433/postgres`),
      ).not.toThrow();
    }
  });

  test("requires an exact server-returned one-use identity", () => {
    expect(() => assertRestoreTargetIdentity(targetId, targetId)).not.toThrow();
    expect(() => assertRestoreTargetIdentity(targetId, "")).toThrow(
      expect.objectContaining({ code: "REFUSED_TARGET_AUTHORITY" }),
    );
    expect(() =>
      assertRestoreTargetIdentity(
        targetId,
        "drill-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      ),
    ).toThrow(expect.objectContaining({ code: "REFUSED_TARGET_AUTHORITY" }));
    expect(() =>
      assertRestoreTargetIdentity("production", "production"),
    ).toThrow(expect.objectContaining({ code: "INVALID_TARGET_AUTHORITY" }));
  });

  test("keeps the destructive restore off the pooler surface", () => {
    expect(() =>
      assertDirectTarget(
        "postgresql://postgres:pw@restore.internal:6432/postgres",
      ),
    ).toThrow(expect.objectContaining({ code: "REFUSED_POOLER_TARGET" }));
  });

  test("parses only the credential-free canonical pooler port", () => {
    expect(parsePoolerEndpoint("restore.internal:6432")).toEqual({
      host: "restore.internal",
      port: "6432",
    });
    expect(() => parsePoolerEndpoint("restore.internal:5432")).toThrow(
      RecoveryDrillError,
    );
    expect(() => parsePoolerEndpoint("user:pw@restore.internal:6432")).toThrow(
      RecoveryDrillError,
    );
  });

  test("never echoes an invalid target credential", () => {
    try {
      assertDirectTarget("not-a-dsn-with-supersecret");
      throw new Error("expected refusal");
    } catch (error) {
      // error-policy:J3 The harness inspects the explicit invalid-input boundary.
      expect((error as Error).message).not.toContain("supersecret");
    }
  });

  test("rejects bootstrap and other role collisions before restore", () => {
    const globals = [
      "CREATE ROLE postgres;",
      'CREATE ROLE "tenant""quoted";',
      "ALTER ROLE postgres WITH SUPERUSER;",
      "",
    ].join("\n");
    expect(parseGlobalRoleNames(globals)).toEqual([
      "postgres",
      'tenant"quoted',
    ]);
    expect(() => assertNoGlobalRoleCollisions(globals, ["postgres"])).toThrow(
      expect.objectContaining({ code: "REFUSED_NONEMPTY_TARGET" }),
    );
    expect(() =>
      assertNoGlobalRoleCollisions(globals, ["restore_admin"]),
    ).not.toThrow();
  });

  test("archive-owned roles do not collide on an idempotent retry", () => {
    // Remnants of a failed run of the SAME drill (twin settings match the
    // capability) must not block the retry. Roles the archive does NOT
    // define are irrelevant — the drill never creates them, so their
    // presence on the target cannot collide with the restore.
    const globals = ["CREATE ROLE tenant_a;", ""].join("\n");
    expect(() =>
      assertNoGlobalRoleCollisions(globals, ["tenant_a"], ["tenant_a"]),
    ).not.toThrow();
    expect(() =>
      assertNoGlobalRoleCollisions(
        globals,
        ["tenant_a", "tenant_b"],
        ["tenant_a"],
      ),
    ).not.toThrow();
    // A pre-existing role that the archive itself defines and that is NOT
    // exempted as archive-owned still refuses (direct-call contract).
    expect(() =>
      assertNoGlobalRoleCollisions(
        ["CREATE ROLE postgres;", ""].join("\n"),
        ["postgres"],
        ["tenant_a"],
      ),
    ).toThrow(expect.objectContaining({ code: "REFUSED_NONEMPTY_TARGET" }));
  });

  test("makeGlobalsIdempotent rewrites CREATE ROLE into conditional DO blocks", () => {
    const globals = [
      "CREATE ROLE tenant_a;",
      "ALTER ROLE tenant_a WITH LOGIN;",
      "CREATE ROLE tenant_b;",
      "",
    ].join("\n");
    const idempotent = makeGlobalsIdempotent(globals);
    expect(idempotent).toContain("IF NOT EXISTS");
    expect(idempotent).not.toMatch(/(^|\n)CREATE ROLE tenant_a;/);
    expect(idempotent).not.toMatch(/(^|\n)CREATE ROLE tenant_b;/);
    // ALTER ROLE is already idempotent and must pass through untouched.
    expect(idempotent).toContain("ALTER ROLE tenant_a WITH LOGIN;");
    // Role names arrive as quoted literals inside the DO block.
    expect(idempotent).toContain("rolname = 'tenant_a'");
  });

  test("parses the server role inventory and refuses malformed output", () => {
    expect(
      parseRestoreTargetAuthority(
        JSON.stringify({
          target_id: targetId,
          capability: "v1.eliza.restore|...",
          existing_roles: ["restore_admin"],
        }),
      ),
    ).toEqual({
      targetId,
      capability: "v1.eliza.restore|...",
      existingRoles: ["restore_admin"],
    });
    expect(() => parseRestoreTargetAuthority("not-json")).toThrow(
      RecoveryDrillError,
    );
    // Missing the capability twin is malformed: authority is incomplete.
    expect(() =>
      parseRestoreTargetAuthority(
        JSON.stringify({ target_id: targetId, existing_roles: [] }),
      ),
    ).toThrow(RecoveryDrillError);
  });

  test("guards one exact session before any supplied SQL", () => {
    const expiresAt = Date.now() + 3_600_000;
    const guarded = guardPsqlScript("CREATE TABLE data(id int);\n", expiresAt);
    expect(guarded).not.toContain("\\quit");
    expect(guarded).toContain(
      "RAISE EXCEPTION 'restore target authority mismatch'",
    );
    expect(guarded.indexOf("current_setting")).toBeLessThan(
      guarded.indexOf("CREATE TABLE"),
    );
    // Both twin settings are checked: target id AND capability envelope.
    expect(guarded).toContain("eliza.restore_target_id");
    expect(guarded).toContain("eliza.restore_capability");
    // The server-clock expiry check is embedded in the same guard block,
    // before any supplied SQL, and exactly once (#23453 review r8).
    expect(guarded).toContain(
      "restore capability has expired on the server clock",
    );
    expect(guarded.indexOf("eliza_capability_live")).toBeLessThan(
      guarded.indexOf("CREATE TABLE"),
    );
    expect(guarded.split("eliza_capability_live").length - 1).toBe(2);
  });

  test("every guarded script class carries the expiry guard exactly once", () => {
    // #23453 review r8: guard composition is construction-only — every
    // destructive session's script embeds the twin-settings + expiry guards
    // exactly once. A double-wrapped script (the old guardedPsqlFile
    // re-wrap) or an unwrapped one is detectable by these counts.
    const expiresAt = Date.now() + 3_600_000;
    const minted = mintRestoreCapability({
      signingKey: CAP_KEY,
      targetId: CAP_TARGET_ID,
      archiveSha256: CAP_ARCHIVE_SHA,
      expiresAtEpochMs: expiresAt,
    });
    const scripts: Record<string, string> = {
      claim: buildClaimExclusivitySql(minted),
      globals: guardPsqlScript(
        makeGlobalsIdempotent("CREATE ROLE tenant_a;\n"),
        expiresAt,
      ),
      consume: guardedConsumeAuthoritySql(expiresAt),
      drop: guardPsqlScript(
        ['DROP DATABASE IF EXISTS "db";', 'CREATE DATABASE "db";', ""].join(
          "\n",
        ),
        expiresAt,
      ),
      // The two remaining session classes are guarded inline in executeDrill;
      // representative raw SQL pins their composition through the same
      // guardPsqlScript path (pg_restore output / ownership handoff).
      restore: guardPsqlScript("-- pg_restore extracted SQL\n", expiresAt),
      handoff: guardPsqlScript(
        'ALTER DATABASE "db" OWNER TO "tenant_a";\n',
        expiresAt,
      ),
    };
    const bodyMarkers: Record<string, string> = {
      claim: "pg_advisory_xact_lock",
      globals: "IF NOT EXISTS",
      consume: "ALTER SYSTEM RESET",
      drop: "DROP DATABASE",
      restore: "pg_restore extracted",
      handoff: "OWNER TO",
    };
    for (const [name, script] of Object.entries(scripts)) {
      // Twin-settings guard once: one gset assignment + one \if read.
      expect(script.split("eliza_restore_target_ok").length - 1, name).toBe(2);
      // Expiry guard once: the variable is set and read inside one block.
      expect(script.split("eliza_capability_live").length - 1, name).toBe(2);
      // Guard block precedes the class's own first body statement.
      const guardEnd = script.indexOf("restore capability has expired");
      const bodyStart = script.indexOf(bodyMarkers[name]);
      expect(guardEnd, name).toBeGreaterThanOrEqual(0);
      expect(bodyStart, name).toBeGreaterThanOrEqual(0);
      expect(guardEnd, name).toBeLessThan(bodyStart);
    }
    // Double-wrapping is detectable: guardPsqlScript applied to an already
    // guarded script doubles both markers.
    const doubleWrapped = guardPsqlScript(scripts.globals, expiresAt);
    expect(doubleWrapped.split("eliza_restore_target_ok").length - 1).toBe(4);
    expect(doubleWrapped.split("eliza_capability_live").length - 1).toBe(4);
  });

  test("quotes tenant identifiers and targets the restored database", () => {
    expect(quoteSqlIdentifier('tenant"quoted')).toBe('"tenant""quoted"');
    expect(
      targetDatabaseDsn(
        "postgresql://restore:pw@127.0.0.1:5433/postgres",
        "tenant/a b",
      ),
    ).toBe("postgresql://restore:pw@127.0.0.1:5433/tenant%2Fa%20b");
  });

  test("consuming the authority re-verifies inside the same guard, then resets and reloads", () => {
    const expiresAt = Date.now() + 3_600_000;
    const script = guardedConsumeAuthoritySql(expiresAt);
    // Same guard as every other destructive statement — a mismatched setting
    // raises before ALTER SYSTEM is ever reached.
    expect(script.startsWith(guardPsqlScript("", expiresAt))).toBe(true);
    expect(script).toContain("ALTER SYSTEM RESET eliza.restore_target_id;");
    expect(script).toContain("ALTER SYSTEM RESET eliza.restore_capability;");
    expect(script).toContain("SELECT pg_reload_conf();");
    expect(script.indexOf("current_setting")).toBeLessThan(
      script.indexOf("ALTER SYSTEM RESET"),
    );
    expect(script.indexOf("ALTER SYSTEM RESET")).toBeLessThan(
      script.indexOf("SELECT pg_reload_conf();"),
    );
  });
});

describe("isCrossTenantDenial", () => {
  test("accepts both the direct-Postgres and pgbouncer cross-tenant denial shapes", () => {
    expect(
      isCrossTenantDenial(
        'psql: error: FATAL:  permission denied for database "tenant_b"',
      ),
    ).toBe(true);
    expect(isCrossTenantDenial("FATAL: No such database: tenant_b")).toBe(true);
    expect(isCrossTenantDenial("psql: error: connection refused")).toBe(false);
    expect(isCrossTenantDenial("")).toBe(false);
  });
});

describe("checksum verification", () => {
  let workDir: string | undefined;
  afterEach(() => {
    if (workDir !== undefined)
      rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  });

  function sha256(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  test("verifies matching files and counts them", () => {
    workDir = mkdtempSync(join(tmpdir(), "drill-test-"));
    mkdirSync(join(workDir, "dumps"));
    writeFileSync(join(workDir, "globals.sql"), "CREATE ROLE t;\n");
    writeFileSync(join(workDir, "dumps", "abc123abc123.dump"), "dumpbytes");
    const text = `${sha256("CREATE ROLE t;\n")}  globals.sql\n${sha256("dumpbytes")}  dumps/abc123abc123.dump\n`;
    expect(verifyChecksums(workDir, parseChecksumFile(text))).toBe(2);
  });

  test("fails closed on tamper, missing file, and path escape", () => {
    workDir = mkdtempSync(join(tmpdir(), "drill-test-"));
    writeFileSync(join(workDir, "globals.sql"), "TAMPERED");
    const good = `${sha256("original")}  globals.sql\n`;
    expect(() =>
      verifyChecksums(workDir as string, parseChecksumFile(good)),
    ).toThrow(expect.objectContaining({ code: "CHECKSUM_MISMATCH" }));
    const missing = `${sha256("x")}  nope.bin\n`;
    expect(() =>
      verifyChecksums(workDir as string, parseChecksumFile(missing)),
    ).toThrow(expect.objectContaining({ code: "CHECKSUM_MISSING_FILE" }));
    const escaping = `${sha256("x")}  ../etc/passwd\n`;
    expect(() =>
      verifyChecksums(workDir as string, parseChecksumFile(escaping)),
    ).toThrow(expect.objectContaining({ code: "INVALID_METADATA" }));
  });

  test("rejects malformed and empty checksum files", () => {
    expect(() => parseChecksumFile("gibberish\n")).toThrow(RecoveryDrillError);
    expect(() => parseChecksumFile("\n\n")).toThrow(RecoveryDrillError);
  });
});

describe("parseDbMap", () => {
  test("parses valid rows and rejects duplicates/malformed rows", () => {
    const entries = parseDbMap(
      "aaaaaaaaaaaa\ttenant_one\nbbbbbbbbbbbb\ttenant_two\n",
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      dumpId: "aaaaaaaaaaaa",
      databaseName: "tenant_one",
    });
    expect(() => parseDbMap("aaaaaaaaaaaa\tx\naaaaaaaaaaaa\ty\n")).toThrow(
      RecoveryDrillError,
    );
    expect(() => parseDbMap("shortid\tx\n")).toThrow(RecoveryDrillError);
    expect(() => parseDbMap("aaaaaaaaaaaa\tx\textra\n")).toThrow(
      RecoveryDrillError,
    );
  });
});

describe("parseTenantProbes", () => {
  const databases = [
    { dumpId: "a".repeat(12), databaseName: "tenant_one" },
    { dumpId: "b".repeat(12), databaseName: "tenant_two" },
  ];

  test("requires one credential reference per restored database", () => {
    const probes = parseTenantProbes(
      JSON.stringify({
        schema_version: 1,
        tenants: [
          {
            dump_id: "a".repeat(12),
            role: "tenant_role_one",
            password_env: "DRILL_TENANT_ONE_PASSWORD",
          },
          {
            dump_id: "b".repeat(12),
            role: "tenant_role_two",
            password_env: "DRILL_TENANT_TWO_PASSWORD",
          },
        ],
      }),
      databases,
    );
    expect(probes).toHaveLength(2);
    expect(JSON.stringify(probes)).not.toContain("tenant_one");
    expect(JSON.stringify(probes)).not.toContain("password-value");
  });

  test("rejects missing coverage, duplicates, and unsafe env references", () => {
    for (const tenants of [
      [
        {
          dump_id: "a".repeat(12),
          role: "r1",
          password_env: "DRILL_PASSWORD",
        },
      ],
      [
        {
          dump_id: "a".repeat(12),
          role: "r1",
          password_env: "DRILL_PASSWORD",
        },
        {
          dump_id: "a".repeat(12),
          role: "r2",
          password_env: "DRILL_PASSWORD_TWO",
        },
      ],
      [
        {
          dump_id: "a".repeat(12),
          role: "r1",
          password_env: "not-an-env-name",
        },
        {
          dump_id: "b".repeat(12),
          role: "r2",
          password_env: "DRILL_PASSWORD_TWO",
        },
      ],
    ]) {
      expect(() =>
        parseTenantProbes(
          JSON.stringify({ schema_version: 1, tenants }),
          databases,
        ),
      ).toThrow(RecoveryDrillError);
    }
  });
});

describe("root-sourced backup environment", () => {
  const template = readFileSync(
    join(
      import.meta.dir,
      "../../infra/cloud/terraform/hetzner/apps-shared/cloud-init/tenant-db.yaml.tftpl",
    ),
    "utf-8",
  );
  const recoverySource = readFileSync(
    join(import.meta.dir, "apps-tenant-db-recovery.ts"),
    "utf-8",
  );

  test("encodes every Terraform-provided value before shell sourcing", () => {
    for (const value of [
      "backup_s3_endpoint",
      "backup_s3_bucket",
      "backup_s3_prefix",
      "backup_s3_access_key",
      "backup_s3_secret_key",
      "backup_encryption_passphrase",
    ]) {
      expect(template).toContain(`base64encode(${value})`);
    }
    expect(template).toContain("base64encode(tostring(backup_retention_days))");
    expect(template).not.toContain(
      "BACKUP_S3_SECRET_ACCESS_KEY=" + "$" + "{backup_s3_secret_key}",
    );
    expect(template).not.toContain(
      "BACKUP_ENCRYPTION_PASSPHRASE=" + "$" + "{backup_encryption_passphrase}",
    );
  });

  test("decodes only after sourcing syntax-safe base64 assignments", () => {
    const sourceAt = template.indexOf('. "$ENV_FILE"');
    const decodeAt = template.indexOf("base64 --decode");
    expect(sourceAt).toBeGreaterThan(-1);
    expect(decodeAt).toBeGreaterThan(sourceAt);
    expect(recoverySource).not.toContain('"ON_ERROR_STOP=0"');
    expect(recoverySource).toContain(
      "/permission denied for database|no such database/i.test(stderr)",
    );
  });
});

describe("buildIsolationChecks", () => {
  test("plans a linear proof: one own-connect per tenant plus one cross-reject sample", () => {
    const checks = buildIsolationChecks([
      { dumpId: "a".repeat(12), databaseName: "t1" },
      { dumpId: "b".repeat(12), databaseName: "t2" },
      { dumpId: "c".repeat(12), databaseName: "t3" },
    ]);
    expect(checks.filter((c) => c.kind === "own-connect")).toHaveLength(3);
    expect(checks.filter((c) => c.kind === "cross-reject")).toHaveLength(1);
    expect(checks).toHaveLength(4); // linear, not n*(n-1)+n
    // Reports reference dump ids only — tenant names never appear in checks.
    expect(JSON.stringify(checks)).not.toContain("t1");
  });

  test("degrades to own-connect-only when a single tenant is restored", () => {
    const checks = buildIsolationChecks([
      { dumpId: "a".repeat(12), databaseName: "t1" },
    ]);
    expect(checks).toHaveLength(1);
    expect(checks[0].kind).toBe("own-connect");
  });
});

describe("evaluateObjectives", () => {
  const createdAt = new Date("2026-08-20T02:20:00Z");

  test("passes when backup age and restore time are inside the objectives", () => {
    const result = evaluateObjectives(
      createdAt,
      new Date("2026-08-20T10:20:00Z"),
      900,
      {
        rpoHours: 26,
        rtoMinutes: 60,
      },
    );
    expect(result).toEqual({
      rpoSeconds: 8 * 3600,
      rpoMet: true,
      rtoSeconds: 900,
      rtoMet: true,
      met: true,
    });
  });

  test("fails RPO on a stale backup and RTO on a slow restore", () => {
    const stale = evaluateObjectives(
      createdAt,
      new Date("2026-08-22T10:20:00Z"),
      900,
      {
        rpoHours: 26,
        rtoMinutes: 60,
      },
    );
    expect(stale.rpoMet).toBe(false);
    expect(stale.met).toBe(false);
    const slow = evaluateObjectives(
      createdAt,
      new Date("2026-08-20T03:20:00Z"),
      4000,
      {
        rpoHours: 26,
        rtoMinutes: 60,
      },
    );
    expect(slow.rtoMet).toBe(false);
    expect(slow.met).toBe(false);
  });
});

describe("parseCliArgs", () => {
  test("parses a full drill invocation with defaults", () => {
    const options = parseCliArgs([
      "--set-dir",
      "/tmp/set",
      "--target-dsn",
      "postgresql://p:***@127.0.0.1:5433/postgres",
      "--target-id",
      "drill-11111111-2222-4333-8444-555555555555",
      "--capability-file",
      "/tmp/cap.txt",
      "--pooler-endpoint",
      "127.0.0.1:6432",
      "--tenant-probes-file",
      "/tmp/probes.json",
      "--passphrase-file",
      "/tmp/pass",
    ]);
    expect(options.rpoHours).toBe(26);
    expect(options.rtoMinutes).toBe(60);
    expect(options.output).toBeUndefined();
    expect(options.capabilityFile).toBe("/tmp/cap.txt");
  });

  test("rejects missing required flags and non-positive objectives", () => {
    expect(() => parseCliArgs(["--set-dir", "/tmp/set"])).toThrow(
      expect.objectContaining({ code: "INVALID_ARGS" }),
    );
    expect(() =>
      parseCliArgs([
        "--set-dir",
        "/tmp/set",
        "--target-dsn",
        "postgresql://p:x@h:5433/d",
        "--passphrase-file",
        "/tmp/pass",
        "--rpo-hours",
        "0",
      ]),
    ).toThrow(expect.objectContaining({ code: "INVALID_ARGS" }));
  });
});

const CAP_TARGET_ID = "drill-11111111-2222-4333-8444-555555555555";
const CAP_ARCHIVE_SHA = "b".repeat(64);
const CAP_KEY = "test-signing-key";

function wellFormedCapabilityEnvelope(
  issuedAtEpochMs: number,
  expiresAtEpochMs: number,
  signatureHex: string,
): string {
  return `v1.eliza.restore|${CAP_TARGET_ID}|${CAP_ARCHIVE_SHA}|${issuedAtEpochMs}|${expiresAtEpochMs}|${signatureHex}`;
}

describe("restore capability (#23453)", () => {
  test("round-trips mint -> serialize -> parse -> verify", () => {
    const minted = mintRestoreCapability({
      signingKey: CAP_KEY,
      targetId: CAP_TARGET_ID,
      archiveSha256: CAP_ARCHIVE_SHA,
      expiresAtEpochMs: Date.now() + 3_600_000,
    });
    const parsed = parseRestoreCapability(serializeRestoreCapability(minted));
    expect(parsed.targetId).toBe(CAP_TARGET_ID);
    expect(parsed.archiveSha256).toBe(CAP_ARCHIVE_SHA);
    expect(() =>
      verifyRestoreCapability(parsed, CAP_KEY, Date.now()),
    ).not.toThrow();
  });

  test("refuses a tampered signature (substitution)", () => {
    const minted = mintRestoreCapability({
      signingKey: CAP_KEY,
      targetId: CAP_TARGET_ID,
      archiveSha256: CAP_ARCHIVE_SHA,
      expiresAtEpochMs: Date.now() + 3_600_000,
    });
    const flipped =
      ("0" === minted.signature.slice(0, 1) ? "1" : "0") +
      minted.signature.slice(1);
    const tampered = parseRestoreCapability(
      wellFormedCapabilityEnvelope(
        minted.issuedAtEpochMs,
        minted.expiresAtEpochMs,
        flipped,
      ),
    );
    expect(() =>
      verifyRestoreCapability(tampered, CAP_KEY, Date.now()),
    ).toThrow(
      expect.objectContaining({ code: "REFUSED_CAPABILITY_SIGNATURE" }),
    );
  });

  test("refuses an expired capability and one with a beyond-ceiling TTL", () => {
    const minted = mintRestoreCapability({
      signingKey: CAP_KEY,
      targetId: CAP_TARGET_ID,
      archiveSha256: CAP_ARCHIVE_SHA,
      expiresAtEpochMs: Date.now() + 60_000,
    });
    expect(() =>
      verifyRestoreCapability(minted, CAP_KEY, Date.now() + 120_000),
    ).toThrow(expect.objectContaining({ code: "CAPABILITY_EXPIRED" }));
    expect(() =>
      mintRestoreCapability({
        signingKey: CAP_KEY,
        targetId: CAP_TARGET_ID,
        archiveSha256: CAP_ARCHIVE_SHA,
        expiresAtEpochMs: Date.now() + MAX_CAPABILITY_TTL_MS + 60_000,
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_CAPABILITY" }));
  });

  test("refuses a re-signed capability binding a different archive (cross-key substitution)", () => {
    // Attacker with their own key pins a DIFFERENT archive to our target id.
    const attacker = mintRestoreCapability({
      signingKey: "attacker-key",
      targetId: CAP_TARGET_ID,
      archiveSha256: "c".repeat(64),
      expiresAtEpochMs: Date.now() + 3_600_000,
    });
    expect(() =>
      verifyRestoreCapability(attacker, CAP_KEY, Date.now()),
    ).toThrow(
      expect.objectContaining({ code: "REFUSED_CAPABILITY_SIGNATURE" }),
    );
  });

  test("rejects malformed envelopes outright", () => {
    expect(() => parseRestoreCapability("garbage")).toThrow(
      expect.objectContaining({ code: "INVALID_CAPABILITY" }),
    );
    expect(() =>
      parseRestoreCapability(
        `v1.eliza.restore|not-a-target|aa|1|1|${"0".repeat(128)}`,
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_CAPABILITY" }));
  });

  test("refuses a signed capability whose lifetime exceeds the ceiling", () => {
    // Even a correctly-signed grant cannot claim a span beyond the TTL
    // ceiling: the ceiling is proven from the signed bytes.
    const minted = mintRestoreCapability({
      signingKey: CAP_KEY,
      targetId: CAP_TARGET_ID,
      archiveSha256: CAP_ARCHIVE_SHA,
      expiresAtEpochMs: Date.now() + 60_000,
    });
    const stretched = {
      ...minted,
      expiresAtEpochMs: minted.issuedAtEpochMs + MAX_CAPABILITY_TTL_MS + 1,
      payload: `v1.eliza.restore|${CAP_TARGET_ID}|${CAP_ARCHIVE_SHA}|${minted.issuedAtEpochMs}|${minted.issuedAtEpochMs + MAX_CAPABILITY_TTL_MS + 1}`,
    };
    // Re-sign so only the lifetime check can refuse it.
    stretched.signature = createHmac("sha256", CAP_KEY)
      .update(stretched.payload, "utf-8")
      .digest("hex");
    expect(() =>
      verifyRestoreCapability(stretched, CAP_KEY, Date.now()),
    ).toThrow(expect.objectContaining({ code: "INVALID_CAPABILITY" }));
  });

  test("refuses a capability whose issuedAt is in the future", () => {
    const minted = mintRestoreCapability({
      signingKey: CAP_KEY,
      targetId: CAP_TARGET_ID,
      archiveSha256: CAP_ARCHIVE_SHA,
      expiresAtEpochMs: Date.now() + 60_000,
    });
    expect(() =>
      verifyRestoreCapability(
        minted,
        CAP_KEY,
        minted.issuedAtEpochMs - 120_000,
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_CAPABILITY" }));
  });
});

describe("authenticated recovery point (#23453)", () => {
  test("accepts a sidecar/manifest pair within the freshness window", () => {
    const t0 = new Date("2026-08-25T00:00:00Z");
    expect(() =>
      assertRecoveryPointConsistency({
        sidecarCreatedAt: t0,
        manifestCreatedAt: new Date(t0.getTime() + 30_000),
        nowEpochMs: t0.getTime() + 3_600_000,
      }),
    ).not.toThrow();
  });

  test("refuses a stale sidecar (cannot understate data loss)", () => {
    const t0 = new Date("2026-08-25T00:00:00Z");
    expect(() =>
      assertRecoveryPointConsistency({
        sidecarCreatedAt: t0,
        manifestCreatedAt: new Date(t0.getTime() + 3_600_000),
        nowEpochMs: t0.getTime() + 3_600_000,
      }),
    ).toThrow(expect.objectContaining({ code: "REFUSED_RECOVERY_POINT" }));
  });

  test("refuses a future-dated manifest beyond the window", () => {
    const t0 = new Date("2026-08-25T00:00:00Z");
    expect(() =>
      assertRecoveryPointConsistency({
        sidecarCreatedAt: t0,
        manifestCreatedAt: new Date(t0.getTime() + 10 * 60_000),
        nowEpochMs: t0.getTime(),
      }),
    ).toThrow(expect.objectContaining({ code: "REFUSED_RECOVERY_POINT" }));
  });

  test("refuses unparseable timestamps instead of passing by NaN comparison", () => {
    // Math.abs(NaN) > WINDOW and NaN > now are both false, so an Invalid
    // Date on either side must be rejected explicitly (#23453 review r8).
    const t0 = new Date("2026-08-25T00:00:00Z");
    expect(() =>
      assertRecoveryPointConsistency({
        sidecarCreatedAt: new Date("not-a-timestamp"),
        manifestCreatedAt: t0,
        nowEpochMs: t0.getTime() + 3_600_000,
      }),
    ).toThrow(expect.objectContaining({ code: "REFUSED_RECOVERY_POINT" }));
    expect(() =>
      assertRecoveryPointConsistency({
        sidecarCreatedAt: t0,
        manifestCreatedAt: new Date("not-a-timestamp"),
        nowEpochMs: t0.getTime() + 3_600_000,
      }),
    ).toThrow(expect.objectContaining({ code: "REFUSED_RECOVERY_POINT" }));
  });
});

describe("capability claim exclusivity (#23453)", () => {
  test("claims under the advisory lock and refuses nothing for the same capability", () => {
    const minted = mintRestoreCapability({
      signingKey: CAP_KEY,
      targetId: CAP_TARGET_ID,
      archiveSha256: CAP_ARCHIVE_SHA,
      expiresAtEpochMs: Date.now() + 3_600_000,
    });
    const sql = buildClaimExclusivitySql(minted);
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("eliza_restore_drill_claim");
    expect(sql).toContain(
      "RAISE EXCEPTION 'a different restore capability already claims this target'",
    );
    // Guarded: settings check precedes the transaction.
    expect(sql.indexOf("current_setting")).toBeLessThan(sql.indexOf("BEGIN;"));
  });
});

describe("authenticated archive coverage (#23453)", () => {
  test("refuses checksums that omit any consumed artifact", () => {
    const good = [
      { sha256: "a".repeat(64), file: "manifest.json" },
      { sha256: "b".repeat(64), file: "globals.sql" },
      { sha256: "c".repeat(64), file: "dbmap.tsv" },
      { sha256: "d".repeat(64), file: "dumps/aaaaaaaaaaaa.dump" },
    ];
    expect(() => assertChecksumCoverage(good, ["aaaaaaaaaaaa"])).not.toThrow();
    for (const drop of [0, 1, 2, 3]) {
      const missing = good.filter((_, i) => i !== drop);
      expect(() => assertChecksumCoverage(missing, ["aaaaaaaaaaaa"])).toThrow(
        expect.objectContaining({ code: "INVALID_METADATA" }),
      );
    }
  });

  test("refuses probe roles absent from the archive globals", () => {
    const probes = [
      { dumpId: "aaaaaaaaaaaa", role: "tenant_a", passwordEnv: "PW_A" },
    ];
    expect(() =>
      assertProbesCoverArchiveRoles(probes, ["tenant_a"]),
    ).not.toThrow();
    // A tampered probes file naming an attacker-chosen role is refused.
    expect(() => assertProbesCoverArchiveRoles(probes, ["tenant_b"])).toThrow(
      expect.objectContaining({ code: "INVALID_PROBE_METADATA" }),
    );
  });
});
