/**
 * Tests for the agent-backup service: snapshot capture + restore and the
 * KMS-encrypted local backup envelope. Exercised against a real tmpdir
 * filesystem, a real in-memory KMS backend, and the real PGlite `dumpDataDir`
 * path via a stub adapter — deterministic, no network.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, test } from "vitest";
import {
  type AgentBackupStateData,
  AgentSnapshotBudgetExceededError,
  createAgentSnapshot,
  createLocalAgentBackup,
  listLocalAgentBackups,
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

describe("source-side snapshot budget (#17172 §1)", () => {
  afterEach(() => {
    restoreEnv();
  });

  async function fixtureRoot(): Promise<{ root: string; pgliteDir: string }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-budget-"));
    const pgliteDir = path.join(root, "pglite");
    process.env.ELIZA_STATE_DIR = root;
    process.env.PGLITE_DATA_DIR = pgliteDir;
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;
    await writeFixtureState(root, pgliteDir);
    return { root, pgliteDir };
  }

  const config = {
    agents: { defaults: { workspace: "/tmp/workspace" } },
  } as never;
  const runtime = () => runtimeStub("11111111-1111-4111-8111-111111111111");

  test("refuses a capture whose files exceed the byte budget", async () => {
    const { root } = await fixtureRoot();
    // A media file comfortably past a deliberately tiny budget.
    await fs.writeFile(
      path.join(root, "media", "big.bin"),
      Buffer.alloc(64 * 1024, 7),
    );

    await expect(
      createAgentSnapshot(runtime(), config, { maxRawBytes: 4096 }),
    ).rejects.toBeInstanceOf(AgentSnapshotBudgetExceededError);
  });

  test("refuses BEFORE reading the oversized file, not after materializing it", async () => {
    // The refusal must come from the declared size: an entry transiently costs
    // ~2.33x its bytes, so charging post-read is charging post-damage.
    const { root } = await fixtureRoot();
    const bigPath = path.join(root, "media", "big.bin");
    await fs.writeFile(bigPath, Buffer.alloc(256 * 1024, 3));

    const realReadFile = fs.readFile;
    const readPaths: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: test double for a node API
    (fs as any).readFile = async (target: any, ...rest: any[]) => {
      readPaths.push(String(target));
      // biome-ignore lint/suspicious/noExplicitAny: forwarding to the real API
      return (realReadFile as any)(target, ...rest);
    };
    try {
      await expect(
        createAgentSnapshot(runtime(), config, { maxRawBytes: 4096 }),
      ).rejects.toBeInstanceOf(AgentSnapshotBudgetExceededError);
      expect(readPaths).not.toContain(bigPath);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restoring the real API
      (fs as any).readFile = realReadFile;
    }
  });

  test("refuses a capture with more files than the count budget", async () => {
    const { root } = await fixtureRoot();
    const mediaDir = path.join(root, "media");
    for (let i = 0; i < 8; i++) {
      await fs.writeFile(path.join(mediaDir, `f${i}.bin`), "x");
    }

    await expect(
      createAgentSnapshot(runtime(), config, { maxFiles: 3 }),
    ).rejects.toBeInstanceOf(AgentSnapshotBudgetExceededError);
  });

  test("an already-aborted signal stops the capture", async () => {
    await fixtureRoot();
    const controller = new AbortController();
    controller.abort();

    await expect(
      createAgentSnapshot(runtime(), config, { signal: controller.signal }),
    ).rejects.toThrow();
  });

  test("a capture within budget still succeeds unchanged", async () => {
    await fixtureRoot();
    const snapshot = await createAgentSnapshot(runtime(), config);
    expect(snapshot.manifest.components.media.files.length).toBeGreaterThan(0);
  });
});
