/**
 * Deterministic unit coverage for the tenant-DB restore-drill harness
 * (#21729): metadata parsing, checksum verification against real files on
 * disk, DSN redaction, isolated-target refusal, isolation-check planning, and
 * RPO/RTO evaluation. No Postgres or object storage involved — the live drill
 * path is exercised by operators against a real isolated instance.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertIsolatedTarget,
  buildIsolationChecks,
  evaluateObjectives,
  parseBackupManifest,
  parseBackupSidecar,
  parseChecksumFile,
  parseCliArgs,
  parseDbMap,
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

describe("assertIsolatedTarget", () => {
  test("accepts an isolated local target", () => {
    expect(() =>
      assertIsolatedTarget("postgresql://postgres:pw@127.0.0.1:5433/postgres"),
    ).not.toThrow();
  });

  test("refuses the live shared tenant DB private IP", () => {
    expect(() =>
      assertIsolatedTarget("postgresql://postgres:pw@10.30.1.10:5432/postgres"),
    ).toThrow(expect.objectContaining({ code: "REFUSED_PRODUCTION_TARGET" }));
  });

  test("refusal message redacts the credential", () => {
    try {
      assertIsolatedTarget(
        "postgresql://postgres:supersecret@10.30.1.10:5432/postgres",
      );
      throw new Error("expected refusal");
    } catch (error) {
      expect((error as Error).message).not.toContain("supersecret");
    }
  });

  test("refuses the pooler port even on another host", () => {
    expect(() =>
      assertIsolatedTarget(
        "postgresql://postgres:pw@192.168.7.2:6432/postgres",
      ),
    ).toThrow(expect.objectContaining({ code: "REFUSED_POOLER_TARGET" }));
  });

  test("refuses non-postgres URLs and garbage", () => {
    expect(() => assertIsolatedTarget("mysql://a:b@c:3306/d")).toThrow(
      RecoveryDrillError,
    );
    expect(() => assertIsolatedTarget("::::")).toThrow(RecoveryDrillError);
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
