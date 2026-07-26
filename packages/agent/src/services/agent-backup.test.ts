/**
 * Tests for the agent-backup service: snapshot capture + restore and the
 * KMS-encrypted local backup envelope. Exercised against a real tmpdir
 * filesystem, a real in-memory KMS backend, and a live PGlite database through
 * its native `dumpDataDir` path — deterministic, no network.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, test } from "vitest";
import {
  type AgentBackupStateData,
  createAgentSnapshot,
  createLocalAgentBackup,
  listLocalAgentBackups,
  parseAgentSnapshotRequest,
  restoreAgentSnapshot,
  restoreLocalAgentBackup,
} from "./agent-backup.ts";

const ORIGINAL_ENV = {
  ELIZA_STATE_DIR: process.env.ELIZA_STATE_DIR,
  ELIZA_NAMESPACE: process.env.ELIZA_NAMESPACE,
  ELIZA_KMS_BACKEND: process.env.ELIZA_KMS_BACKEND,
  PGLITE_DATA_DIR: process.env.PGLITE_DATA_DIR,
  POSTGRES_URL: process.env.POSTGRES_URL,
  DATABASE_URL: process.env.DATABASE_URL,
  NODE_ENV: process.env.NODE_ENV,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function runtimeStub(agentId: string): AgentRuntime {
  return {
    agentId,
    character: { name: "Backup Test Agent" },
    adapter: {
      close: async () => undefined,
    },
    getSetting: () => null,
  } as unknown as AgentRuntime;
}

function postgresRuntimeStub(
  agentId: string,
  postgresUrl: string | null,
): AgentRuntime {
  return {
    ...runtimeStub(agentId),
    getSetting: (key: string) => (key === "POSTGRES_URL" ? postgresUrl : null),
  } as unknown as AgentRuntime;
}

async function writeFixtureState(
  root: string,
  pgliteDir: string,
): Promise<void> {
  await fs.mkdir(path.join(root, "media"), { recursive: true });
  await fs.mkdir(path.join(root, ".vault-pglite"), { recursive: true });
  await fs.mkdir(path.join(root, "audit"), { recursive: true });
  await fs.mkdir(path.join(root, "skills"), { recursive: true });
  await fs.mkdir(pgliteDir, { recursive: true });

  await fs.writeFile(path.join(root, "eliza.json"), '{"name":"fixture"}\n');
  await fs.writeFile(
    path.join(root, "media", `${"a".repeat(64)}.txt`),
    "media-bytes",
  );
  await fs.writeFile(
    path.join(root, "vault.json"),
    '{"version":1,"entries":{}}\n',
    {
      mode: 0o600,
    },
  );
  await fs.writeFile(
    path.join(root, ".vault-pglite", "data.bin"),
    "ciphertext-ish",
  );
  await fs.writeFile(
    path.join(root, "audit", "vault.jsonl"),
    '{"event":"unlock"}\n',
  );
  await fs.writeFile(
    path.join(root, "skills", "active.json"),
    '{"skills":[]}\n',
  );
  await fs.writeFile(path.join(pgliteDir, "pgdata.bin"), "database-bytes");
  await fs.writeFile(
    path.join(pgliteDir, "postmaster.pid"),
    `${process.pid}\n`,
  );
  await fs.writeFile(path.join(pgliteDir, "postmaster.opts"), "runtime opts");
  await fs.writeFile(
    path.join(pgliteDir, "eliza-pglite.lock"),
    JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
  );
  await fs.mkdir(path.join(pgliteDir, "pg_stat_tmp"), { recursive: true });
  await fs.writeFile(
    path.join(pgliteDir, "pg_stat_tmp", "stats.tmp"),
    "runtime stats",
  );
}

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

describe("agent backup manifest", () => {
  afterEach(() => {
    restoreEnv();
  });

  test("resolves only supported snapshot purpose and schema combinations", () => {
    expect(parseAgentSnapshotRequest()).toEqual({
      purpose: "manual",
      schemaVersion: 1,
    });
    expect(parseAgentSnapshotRequest({})).toEqual({
      purpose: "manual",
      schemaVersion: 1,
    });
    expect(parseAgentSnapshotRequest({ purpose: "auto" })).toEqual({
      purpose: "auto",
      schemaVersion: 1,
    });
    expect(parseAgentSnapshotRequest({ purpose: "pre-upgrade" })).toEqual({
      purpose: "pre-upgrade",
      schemaVersion: 2,
    });
    expect(
      parseAgentSnapshotRequest({
        purpose: "pre-upgrade",
        schemaVersion: 2,
      }),
    ).toEqual({
      purpose: "pre-upgrade",
      schemaVersion: 2,
    });

    for (const request of [
      null,
      [],
      { purpose: "release" },
      { purpose: "manual", schemaVersion: 2 },
      { purpose: "auto", schemaVersion: 2 },
      { purpose: "pre-upgrade", schemaVersion: 1 },
      { purpose: "manual", schemaVersion: 3 },
      { purpose: "manual", typo: true },
    ]) {
      expect(() => parseAgentSnapshotRequest(request)).toThrow();
    }
  });

  test("does not expose invalid connection URL content in identity errors", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-agent-backup-v2-url-privacy-"),
    );
    process.env.ELIZA_STATE_DIR = root;
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;
    const agentId = "10000000-0000-4000-8000-000000000009";
    const secretProtocol = "credential-secret";
    const runtime = postgresRuntimeStub(
      agentId,
      `${secretProtocol}://owner:password@db.example.com/eliza`,
    );

    try {
      await createAgentSnapshot(runtime, {} as never, {
        purpose: "pre-upgrade",
      });
      throw new Error("Expected invalid Postgres URL to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "POSTGRES_URL must use postgres:// or postgresql://",
      );
      expect((error as Error).message).not.toContain(secretProtocol);
      expect((error as Error).message).not.toContain("password");
    }
  });

  test("keeps default, manual, and automatic snapshots on the v1 wire format", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-agent-backup-v1-"),
    );
    const pgliteDir = path.join(root, "pglite");
    process.env.ELIZA_STATE_DIR = root;
    process.env.PGLITE_DATA_DIR = pgliteDir;
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;
    await writeFixtureState(root, pgliteDir);

    const runtime = runtimeStub("10000000-0000-4000-8000-000000000001");
    const defaultSnapshot = await createAgentSnapshot(runtime, {} as never);
    const manualSnapshot = await createAgentSnapshot(runtime, {} as never, {
      purpose: "manual",
      schemaVersion: 1,
    });
    const automaticSnapshot = await createAgentSnapshot(runtime, {} as never, {
      purpose: "auto",
    });

    expect(defaultSnapshot.manifest.schemaVersion).toBe(1);
    expect(manualSnapshot.manifest.schemaVersion).toBe(1);
    expect(automaticSnapshot.manifest.schemaVersion).toBe(1);
    expect(manualSnapshot.manifest.components.database).toEqual(
      defaultSnapshot.manifest.components.database,
    );
    expect(automaticSnapshot.manifest.components.database).toEqual(
      defaultSnapshot.manifest.components.database,
    );
  });

  test("uses a credential-free external Postgres identity for v2 pre-upgrade restore without SQL", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-agent-backup-v2-postgres-"),
    );
    process.env.ELIZA_STATE_DIR = root;
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;
    await fs.mkdir(path.join(root, "media"), { recursive: true });
    await fs.mkdir(path.join(root, "skills"), { recursive: true });
    await fs.writeFile(path.join(root, "eliza.json"), '{"name":"external"}\n');
    await fs.writeFile(path.join(root, "skills", "active.json"), "before");
    await fs.writeFile(
      path.join(root, "media", `${"b".repeat(64)}.txt`),
      "external-media",
    );

    const agentId = "10000000-0000-4000-8000-000000000002";
    const sourceUrl =
      "postgresql://alice:old-password@DB.EXAMPLE.COM/app%5Fdb?schema=tenant&sslpassword=query-secret&access_token=source-token";
    const sourceRuntime = postgresRuntimeStub(agentId, sourceUrl);
    const snapshot = await createAgentSnapshot(sourceRuntime, {} as never, {
      purpose: "pre-upgrade",
      schemaVersion: 2,
    });

    expect(snapshot.manifest.schemaVersion).toBe(2);
    expect(snapshot.manifest.components.database.kind).toBe(
      "external-postgres-reference",
    );
    const reference = snapshot.manifest.components.database.externalPostgres;
    expect(reference).toMatchObject({
      kind: "external-postgres-reference",
      identityVersion: 1,
      algorithm: "sha256",
    });
    expect(reference?.identitySha256).toMatch(/^[a-f0-9]{64}$/);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("old-password");
    expect(serialized).not.toContain("query-secret");
    expect(serialized).not.toContain("source-token");

    await fs.rm(path.join(root, "media"), { recursive: true, force: true });
    await fs.rm(path.join(root, "skills"), { recursive: true, force: true });
    await fs.writeFile(path.join(root, "eliza.json"), '{"name":"changed"}\n');

    const rotatedRuntime = postgresRuntimeStub(
      agentId,
      "postgres://bob:new-password@db.example.com:5432/app_db?search_path=tenant&sslpassword=rotated&access_token=rotated-token",
    );
    await restoreAgentSnapshot(rotatedRuntime, snapshot);

    expect(await readText(path.join(root, "skills", "active.json"))).toBe(
      "before",
    );
    expect(
      await readText(path.join(root, "media", `${"b".repeat(64)}.txt`)),
    ).toBe("external-media");
    expect(await readText(path.join(root, "eliza.json"))).toBe(
      '{"name":"external"}\n',
    );
  });

  test("rejects external Postgres host, port, database, namespace, and agent mismatches", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-agent-backup-v2-binding-"),
    );
    process.env.ELIZA_STATE_DIR = root;
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;
    const agentId = "10000000-0000-4000-8000-000000000003";
    const sourceRuntime = postgresRuntimeStub(
      agentId,
      "postgres://owner:secret@db.example.com:5432/eliza?schema=tenant",
    );
    const snapshot = await createAgentSnapshot(sourceRuntime, {} as never, {
      purpose: "pre-upgrade",
    });

    for (const postgresUrl of [
      "postgres://owner:secret@other.example.com:5432/eliza?schema=tenant",
      "postgres://owner:secret@db.example.com:5433/eliza?schema=tenant",
      "postgres://owner:secret@db.example.com:5432/other?schema=tenant",
      "postgres://owner:secret@db.example.com:5432/eliza?schema=other",
    ]) {
      await expect(
        restoreAgentSnapshot(
          postgresRuntimeStub(agentId, postgresUrl),
          snapshot,
        ),
      ).rejects.toThrow(/identity does not match/);
    }

    await expect(
      restoreAgentSnapshot(postgresRuntimeStub(agentId, null), snapshot),
    ).rejects.toThrow(/POSTGRES_URL is not configured/);

    const otherAgentId = "10000000-0000-4000-8000-000000000004";
    const reboundSnapshot = structuredClone(snapshot);
    reboundSnapshot.manifest.agentId = otherAgentId;
    await expect(
      restoreAgentSnapshot(
        postgresRuntimeStub(
          otherAgentId,
          "postgres://owner:secret@db.example.com:5432/eliza?schema=tenant",
        ),
        reboundSnapshot,
      ),
    ).rejects.toThrow(/identity does not match/);
  });

  test("rejects malformed external references and v1 manifests carrying v2 database semantics", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-agent-backup-v2-invalid-"),
    );
    process.env.ELIZA_STATE_DIR = root;
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;
    const agentId = "10000000-0000-4000-8000-000000000006";
    const postgresUrl =
      "postgres://owner:secret@db.example.com:5432/eliza?schema=tenant";
    const runtime = postgresRuntimeStub(agentId, postgresUrl);
    const snapshot = await createAgentSnapshot(runtime, {} as never, {
      purpose: "pre-upgrade",
    });

    const malformedReference = structuredClone(snapshot);
    const reference =
      malformedReference.manifest.components.database.externalPostgres;
    if (!reference) {
      throw new Error("Expected external Postgres reference");
    }
    reference.identitySha256 = "not-a-digest";
    await expect(
      restoreAgentSnapshot(runtime, malformedReference),
    ).rejects.toThrow(/identity is malformed/);

    const referenceWithCredentialResidue = structuredClone(snapshot);
    const residueReference =
      referenceWithCredentialResidue.manifest.components.database
        .externalPostgres;
    if (!residueReference) {
      throw new Error("Expected external Postgres reference");
    }
    Object.assign(residueReference, { password: "must-not-be-accepted" });
    await expect(
      restoreAgentSnapshot(runtime, referenceWithCredentialResidue),
    ).rejects.toThrow(/identity has unsupported fields/);

    const componentWithHydratedResidue = structuredClone(snapshot);
    Object.assign(componentWithHydratedResidue.manifest.components.database, {
      postgres: { tables: [], sha256: "0".repeat(64) },
    });
    await expect(
      restoreAgentSnapshot(runtime, componentWithHydratedResidue),
    ).rejects.toThrow(/database component has unsupported fields/);

    const v1WithExternalReference = structuredClone(snapshot);
    v1WithExternalReference.manifest.schemaVersion = 1;
    await expect(
      restoreAgentSnapshot(runtime, v1WithExternalReference),
    ).rejects.toThrow(
      /Schema version 1 cannot contain an external Postgres reference/,
    );

    const unknownSchema = structuredClone(snapshot) as unknown as {
      manifest: { schemaVersion: number };
    };
    unknownSchema.manifest.schemaVersion = 3;
    await expect(
      restoreAgentSnapshot(
        runtime,
        unknownSchema as unknown as AgentBackupStateData,
      ),
    ).rejects.toThrow(/Unsupported or missing elizaOS backup manifest/);
  });

  test("captures and restores actual PGlite bytes for v2 pre-upgrade snapshots", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-agent-backup-v2-pglite-"),
    );
    const pgliteDir = path.join(root, "pglite");
    process.env.ELIZA_STATE_DIR = root;
    process.env.PGLITE_DATA_DIR = pgliteDir;
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;
    await writeFixtureState(root, pgliteDir);
    const runtime = runtimeStub("10000000-0000-4000-8000-000000000005");

    const snapshot = await createAgentSnapshot(runtime, {} as never, {
      purpose: "pre-upgrade",
    });
    expect(snapshot.manifest.schemaVersion).toBe(2);
    expect(snapshot.manifest.components.database.kind).toBe("pglite-files");
    expect(
      snapshot.manifest.components.database.pglite?.files.map(
        (file) => file.path,
      ),
    ).toContain("pgdata.bin");

    await fs.rm(pgliteDir, { recursive: true, force: true });
    await restoreAgentSnapshot(runtime, snapshot);
    expect(await readText(path.join(pgliteDir, "pgdata.bin"))).toBe(
      "database-bytes",
    );
  });

  test("round-trips a live PGlite database through a v2 pre-upgrade snapshot", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-agent-backup-v2-live-pglite-"),
    );
    const pgliteDir = path.join(root, "pglite");
    process.env.ELIZA_STATE_DIR = root;
    process.env.PGLITE_DATA_DIR = pgliteDir;
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;

    const { PGlite } = await import("@electric-sql/pglite");
    const database = new PGlite(pgliteDir);
    await database.waitReady;
    await database.exec(`
      CREATE TABLE snapshot_probe (
        id INTEGER PRIMARY KEY,
        payload TEXT NOT NULL
      );
      INSERT INTO snapshot_probe (id, payload) VALUES (1, 'captured');
    `);

    let closed = false;
    const runtime = {
      ...runtimeStub("10000000-0000-4000-8000-000000000008"),
      adapter: {
        getRawConnection: () => database,
        close: async () => {
          if (closed) return;
          closed = true;
          await database.close();
        },
      },
    } as unknown as AgentRuntime;

    const snapshot = await createAgentSnapshot(runtime, {} as never, {
      purpose: "pre-upgrade",
    });
    expect(snapshot.manifest.schemaVersion).toBe(2);
    expect(snapshot.manifest.components.database.kind).toBe("pglite-dump");

    await database.exec(
      "INSERT INTO snapshot_probe (id, payload) VALUES (2, 'after-snapshot');",
    );
    await restoreAgentSnapshot(runtime, snapshot);

    const restored = new PGlite(pgliteDir);
    try {
      await restored.waitReady;
      const result = await restored.query<{
        id: number;
        payload: string;
      }>("SELECT id, payload FROM snapshot_probe ORDER BY id");
      expect(result.rows).toEqual([{ id: 1, payload: "captured" }]);
    } finally {
      await restored.close();
    }
  });

  test("fails a v2 pre-upgrade snapshot when PGlite has no durable capture path", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-agent-backup-v2-memory-"),
    );
    process.env.ELIZA_STATE_DIR = root;
    process.env.PGLITE_DATA_DIR = ":memory:";
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;
    const runtime = runtimeStub("10000000-0000-4000-8000-000000000007");

    await expect(
      createAgentSnapshot(runtime, {} as never, {
        purpose: "pre-upgrade",
      }),
    ).rejects.toMatchObject({
      code: "AGENT_SNAPSHOT_DATABASE_UNCAPTURABLE",
    });

    const v1Snapshot = await createAgentSnapshot(runtime, {} as never);
    expect(v1Snapshot.manifest.schemaVersion).toBe(1);
    expect(v1Snapshot.manifest.components.database.kind).toBe("none");
  });

  test("captures and restores local PGlite, media, vault, character, and state-dir files", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-agent-backup-"),
    );
    const pgliteDir = path.join(root, "pglite");
    process.env.ELIZA_STATE_DIR = root;
    process.env.PGLITE_DATA_DIR = pgliteDir;
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;

    await writeFixtureState(root, pgliteDir);

    const runtime = runtimeStub("11111111-1111-4111-8111-111111111111");
    const snapshot = await createAgentSnapshot(runtime, {
      agents: { defaults: { workspace: "/tmp/workspace" } },
    } as never);

    expect(snapshot.manifest.components.database.kind).toBe("pglite-files");
    expect(snapshot.manifest.components.media.files).toHaveLength(1);
    expect(
      snapshot.manifest.components.vault.files.map((file) => file.path).sort(),
    ).toEqual([".vault-pglite/data.bin", "audit/vault.jsonl", "vault.json"]);
    const stateFilePaths = snapshot.manifest.components.stateFiles.files.map(
      (file) => file.path,
    );
    const pgliteComponent = snapshot.manifest.components.database.pglite;
    if (!pgliteComponent) {
      throw new Error("Expected PGlite file-set backup component");
    }
    const pgliteFilePaths = pgliteComponent.files.map((file) => file.path);
    expect(pgliteFilePaths).toContain("pgdata.bin");
    expect(pgliteFilePaths).not.toContain("postmaster.pid");
    expect(pgliteFilePaths).not.toContain("postmaster.opts");
    expect(pgliteFilePaths).not.toContain("eliza-pglite.lock");
    expect(pgliteFilePaths).not.toContain("pg_stat_tmp/stats.tmp");
    expect(stateFilePaths).toContain("skills/active.json");
    expect(stateFilePaths).not.toContain("pglite/pgdata.bin");

    await fs.rm(path.join(root, "media"), { recursive: true, force: true });
    await fs.rm(path.join(root, ".vault-pglite"), {
      recursive: true,
      force: true,
    });
    await fs.rm(path.join(root, "skills"), { recursive: true, force: true });
    await fs.rm(pgliteDir, { recursive: true, force: true });
    await fs.rm(path.join(root, "vault.json"), { force: true });
    await fs.rm(path.join(root, "eliza.json"), { force: true });

    await fs.mkdir(path.join(root, ".vault-pglite"), { recursive: true });
    await fs.mkdir(path.join(root, "skills"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".vault-pglite", "stale.bin"),
      "stale-vault",
    );
    await fs.writeFile(path.join(root, "skills", "stale.json"), "stale-state");

    await restoreAgentSnapshot(runtime, snapshot);

    expect(await readText(path.join(pgliteDir, "pgdata.bin"))).toBe(
      "database-bytes",
    );
    expect(await exists(path.join(pgliteDir, "postmaster.pid"))).toBe(false);
    expect(await exists(path.join(pgliteDir, "postmaster.opts"))).toBe(false);
    expect(await exists(path.join(pgliteDir, "eliza-pglite.lock"))).toBe(false);
    expect(await exists(path.join(pgliteDir, "pg_stat_tmp", "stats.tmp"))).toBe(
      false,
    );
    expect(
      await readText(path.join(root, "media", `${"a".repeat(64)}.txt`)),
    ).toBe("media-bytes");
    expect(await readText(path.join(root, ".vault-pglite", "data.bin"))).toBe(
      "ciphertext-ish",
    );
    expect(await readText(path.join(root, "audit", "vault.jsonl"))).toBe(
      '{"event":"unlock"}\n',
    );
    expect(await readText(path.join(root, "skills", "active.json"))).toBe(
      '{"skills":[]}\n',
    );
    expect(await readText(path.join(root, "eliza.json"))).toBe(
      '{"name":"fixture"}\n',
    );
    expect(await exists(path.join(root, ".vault-pglite", "stale.bin"))).toBe(
      false,
    );
    expect(await exists(path.join(root, "skills", "stale.json"))).toBe(false);
  });

  test("refuses to restore tampered component bytes", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-agent-backup-"),
    );
    const pgliteDir = path.join(root, "pglite");
    process.env.ELIZA_STATE_DIR = root;
    process.env.PGLITE_DATA_DIR = pgliteDir;
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;

    await writeFixtureState(root, pgliteDir);
    const runtime = runtimeStub("22222222-2222-4222-8222-222222222222");
    const snapshot = (await createAgentSnapshot(
      runtime,
      {} as never,
    )) as AgentBackupStateData;

    const firstMedia = snapshot.manifest.components.media.files[0];
    if (!firstMedia) throw new Error("fixture did not create media");
    firstMedia.bytesBase64 = Buffer.from("tampered").toString("base64");

    await expect(restoreAgentSnapshot(runtime, snapshot)).rejects.toThrow(
      /hash mismatch/,
    );
  });

  test("captures live PGlite through dumpDataDir when the adapter exposes it", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-agent-backup-"),
    );
    const pgliteDir = path.join(root, "pglite");
    process.env.ELIZA_STATE_DIR = root;
    process.env.PGLITE_DATA_DIR = pgliteDir;
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;

    await writeFixtureState(root, pgliteDir);

    const dumpBytes = Buffer.from("official-pglite-dump-bytes");
    const rawConnection = {
      ready: true,
      async dumpDataDir(this: { ready: boolean }, compression?: "gzip") {
        expect(this.ready).toBe(true);
        expect(compression).toBe("gzip");
        return new Blob([dumpBytes], { type: "application/gzip" });
      },
      runExclusive: async <T>(operation: () => Promise<T>) => operation(),
    };
    const runtime = {
      ...runtimeStub("44444444-4444-4444-8444-444444444444"),
      adapter: {
        close: async () => undefined,
        getRawConnection: () => rawConnection,
      },
    } as unknown as AgentRuntime;

    const snapshot = await createAgentSnapshot(runtime, {} as never);

    expect(snapshot.manifest.components.database.kind).toBe("pglite-dump");
    const pgliteDump = snapshot.manifest.components.database.pgliteDump;
    expect(pgliteDump?.compression).toBe("gzip");
    expect(pgliteDump?.file.path).toBe("pglite-data-dir.tar.gz");
    expect(Buffer.from(pgliteDump?.file.bytesBase64 ?? "", "base64")).toEqual(
      dumpBytes,
    );
    expect(snapshot.manifest.components.database.pglite).toBeUndefined();
  });

  test("writes encrypted local backup files and restores them", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-agent-backup-"),
    );
    const pgliteDir = path.join(root, "pglite");
    process.env.NODE_ENV = "test";
    process.env.ELIZA_KMS_BACKEND = "memory";
    process.env.ELIZA_STATE_DIR = root;
    process.env.PGLITE_DATA_DIR = pgliteDir;
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;

    await writeFixtureState(root, pgliteDir);

    const runtime = runtimeStub("33333333-3333-4333-8333-333333333333");
    const backup = await createLocalAgentBackup(runtime, {} as never);
    const rawBackup = await readText(backup.path);

    expect(rawBackup).toContain("elizaos.agent-backup-file");
    expect(rawBackup).toContain("kms-aes-256-gcm");
    expect(rawBackup).not.toContain("media-bytes");
    expect(rawBackup).not.toContain("database-bytes");
    expect(rawBackup).not.toContain("ciphertext-ish");
    expect(rawBackup).not.toContain('{"skills":[]}');

    const listed = await listLocalAgentBackups(runtime.agentId);
    expect(listed.map((entry) => entry.fileName)).toEqual([backup.fileName]);
    expect(listed[0]?.stateSha256).toBe(backup.stateSha256);

    await fs.rm(path.join(root, "media"), { recursive: true, force: true });
    await fs.rm(path.join(root, ".vault-pglite"), {
      recursive: true,
      force: true,
    });
    await fs.rm(path.join(root, "skills"), { recursive: true, force: true });
    await fs.rm(pgliteDir, { recursive: true, force: true });
    await fs.rm(path.join(root, "vault.json"), { force: true });
    await fs.rm(path.join(root, "eliza.json"), { force: true });

    await restoreLocalAgentBackup(runtime, backup.fileName);

    expect(await readText(path.join(pgliteDir, "pgdata.bin"))).toBe(
      "database-bytes",
    );
    expect(
      await readText(path.join(root, "media", `${"a".repeat(64)}.txt`)),
    ).toBe("media-bytes");
    expect(await readText(path.join(root, ".vault-pglite", "data.bin"))).toBe(
      "ciphertext-ish",
    );
    expect(await readText(path.join(root, "audit", "vault.jsonl"))).toBe(
      '{"event":"unlock"}\n',
    );
    expect(await readText(path.join(root, "skills", "active.json"))).toBe(
      '{"skills":[]}\n',
    );
    expect(await readText(path.join(root, "eliza.json"))).toBe(
      '{"name":"fixture"}\n',
    );
  });
});
