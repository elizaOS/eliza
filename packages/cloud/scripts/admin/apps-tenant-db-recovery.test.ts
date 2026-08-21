/**
 * Deterministic unit coverage for the tenant-DB restore-drill harness
 * (#21729): metadata parsing, checksum verification against real files on
 * disk, DSN redaction, isolated-target refusal, isolation-check planning, and
 * RPO/RTO evaluation. No Postgres or object storage involved — the live drill
 * path is exercised by operators against a real isolated instance.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
  assertDirectTarget,
  assertRestoreTargetIdentity,
  buildIsolationChecks,
  evaluateObjectives,
  parseBackupManifest,
  parseBackupSidecar,
  parseChecksumFile,
  parseCliArgs,
  parseDbMap,
  parsePoolerEndpoint,
  parseTenantProbes,
  RecoveryDrillError,
  redactDsn,
  verifyChecksums,
} from "./apps-tenant-db-recovery";

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
      expect((error as Error).message).not.toContain("supersecret");
    }
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
      "/permission denied for database/i.test(result.stderr)",
    );
  });
});

describe("buildIsolationChecks", () => {
  test("plans one own-connect plus pairwise cross-reject probes", () => {
    const checks = buildIsolationChecks([
      { dumpId: "a".repeat(12), databaseName: "t1" },
      { dumpId: "b".repeat(12), databaseName: "t2" },
      { dumpId: "c".repeat(12), databaseName: "t3" },
    ]);
    expect(checks.filter((c) => c.kind === "own-connect")).toHaveLength(3);
    expect(checks.filter((c) => c.kind === "cross-reject")).toHaveLength(6);
    // Reports reference dump ids only — tenant names never appear in checks.
    expect(JSON.stringify(checks)).not.toContain("t1");
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
      "postgresql://p:x@127.0.0.1:5433/postgres",
      "--target-id",
      "drill-11111111-2222-4333-8444-555555555555",
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
