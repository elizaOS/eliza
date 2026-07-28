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
  fetchAgentScopedRowsBatched,
  listLocalAgentBackups,
  restoreAgentSnapshot,
  restoreLocalAgentBackup,
  SnapshotBudget,
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

  test("refuses an oversized PGlite dump from Blob.size, before arrayBuffer()", async () => {
    await fixtureRoot();
    let materialized = false;
    const rawConnection = {
      async dumpDataDir() {
        return {
          size: 256 * 1024,
          arrayBuffer: async () => {
            materialized = true;
            return new ArrayBuffer(256 * 1024);
          },
        };
      },
      runExclusive: async <T>(operation: () => Promise<T>) => operation(),
    };
    const withDump = {
      ...runtime(),
      adapter: {
        close: async () => undefined,
        getRawConnection: () => rawConnection,
      },
    } as unknown as AgentRuntime;

    await expect(
      createAgentSnapshot(withDump, config, { maxRawBytes: 4096 }),
    ).rejects.toBeInstanceOf(AgentSnapshotBudgetExceededError);
    // The refusal must come from the declared size: the dump is transiently
    // resident three times over (ArrayBuffer + Buffer + base64) once decoded.
    expect(materialized).toBe(false);
  });

  test("an in-budget PGlite dump is charged, so a sibling cannot spend the same bytes", async () => {
    const { root } = await fixtureRoot();
    // Dump ~48 KiB + a 48 KiB media file: each fits a 96 KiB (base64) budget
    // alone, both together do not.
    const dumpBytes = Buffer.alloc(48 * 1024, 5);
    await fs.writeFile(
      path.join(root, "media", "big.bin"),
      Buffer.alloc(48 * 1024, 7),
    );
    const rawConnection = {
      async dumpDataDir() {
        return new Blob([dumpBytes], { type: "application/gzip" });
      },
      runExclusive: async <T>(operation: () => Promise<T>) => operation(),
    };
    const withDump = {
      ...runtime(),
      adapter: {
        close: async () => undefined,
        getRawConnection: () => rawConnection,
      },
    } as unknown as AgentRuntime;

    await expect(
      createAgentSnapshot(withDump, config, { maxRawBytes: 96 * 1024 }),
    ).rejects.toBeInstanceOf(AgentSnapshotBudgetExceededError);
  });

  test("refuses an oversized file on the pglite-files fallback walk", async () => {
    const { pgliteDir } = await fixtureRoot();
    // No getRawConnection on the stub adapter, so the capture takes the
    // fallback file walk — which used to run with no budget at all.
    await fs.writeFile(
      path.join(pgliteDir, "oversized.wal"),
      Buffer.alloc(256 * 1024, 9),
    );

    await expect(
      createAgentSnapshot(runtime(), config, { maxRawBytes: 64 * 1024 }),
    ).rejects.toBeInstanceOf(AgentSnapshotBudgetExceededError);
  });

  test("concurrent components cannot both pass the check and then allocate past the limit", async () => {
    const { root, pgliteDir } = await fixtureRoot();
    // Two 64 KiB files on two components that capture CONCURRENTLY, with a
    // budget that fits one but not both. An observe-only reserve lets each
    // sibling see zero charged bytes, pass, and read — the limit is then only
    // discovered after both payloads are resident. A real reservation is
    // synchronous, so whichever component reserves second is refused BEFORE
    // its read, whatever the interleaving.
    const mediaBig = path.join(root, "media", "big-a.bin");
    const pgliteBig = path.join(pgliteDir, "big-b.wal");
    await fs.writeFile(mediaBig, Buffer.alloc(64 * 1024, 1));
    await fs.writeFile(pgliteBig, Buffer.alloc(64 * 1024, 2));

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
        // 128 KiB of budget: one 64 KiB file costs ~87 KiB in base64.
        createAgentSnapshot(runtime(), config, { maxRawBytes: 128 * 1024 }),
      ).rejects.toBeInstanceOf(AgentSnapshotBudgetExceededError);
      const bigReads = readPaths.filter(
        (p) => p === mediaBig || p === pgliteBig,
      );
      expect(bigReads.length).toBeLessThanOrEqual(1);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restoring the real API
      (fs as any).readFile = realReadFile;
    }
  });
});

describe("snapshot budget reservation semantics", () => {
  test("a hold claims capacity other reserves must count", () => {
    const budget = new SnapshotBudget(200, 10);
    const hold = budget.reserve(100); // holds base64Length(100) = 136
    expect(() => budget.reserve(100)).toThrow(AgentSnapshotBudgetExceededError);
    hold.release();
    expect(() => budget.reserve(100)).not.toThrow();
  });

  test("commit converts the hold into a charge at the actual encoded size", () => {
    const budget = new SnapshotBudget(200, 10);
    const hold = budget.reserve(100);
    hold.commit(50); // actual entry smaller than declared
    // 50 charged, hold gone: 136 more fits again.
    expect(() => budget.reserve(100)).not.toThrow();
  });

  test("a settled token is inert on double settle", () => {
    const budget = new SnapshotBudget(400, 10);
    const hold = budget.reserve(100);
    hold.commit(50);
    hold.release(); // must not un-charge the committed bytes
    hold.commit(50); // must not double-charge
    const holds = [budget.reserve(100), budget.reserve(100)];
    for (const h of holds) h.release();
    // Exactly 50 charged in total: a 350-byte hold still fits under 400.
    expect(() => budget.reserve(255)).not.toThrow();
  });

  test("file count is enforced at commit time", () => {
    const budget = new SnapshotBudget(10_000, 2);
    budget.reserve(10).commit(10);
    budget.reserve(10).commit(10);
    const third = budget.reserve(10);
    expect(() => third.commit(10)).toThrow(AgentSnapshotBudgetExceededError);
  });
});

describe("keyset-batched Postgres capture (#17172 §1)", () => {
  /** A pool double that serves `total` rows with sequential ids, in pages. */
  function pagingPool(total: number) {
    const statements: string[] = [];
    const all = Array.from({ length: total }, (_, i) => ({
      id: i + 1,
      payload: "x",
    }));
    return {
      statements,
      pageSizes: [] as number[],
      query(text: string, values: unknown[]) {
        statements.push(text);
        const limitMatch = text.match(/LIMIT (\d+)/);
        const limit = limitMatch ? Number(limitMatch[1]) : all.length;
        // The keyset param is appended after the base params.
        const after = values.length > 1 ? Number(values[values.length - 1]) : 0;
        const rows = all.filter((r) => r.id > after).slice(0, limit);
        this.pageSizes.push(rows.length);
        return Promise.resolve({ rows });
      },
    };
  }

  test("walks the whole table in ordered batches without duplicates or gaps", async () => {
    const pool = pagingPool(1200);
    const rows = await fetchAgentScopedRowsBatched(
      pool as never,
      (keyset) => `SELECT * FROM "t" WHERE "agent_id" = $1 ${keyset}`,
      ["agent-1"],
      undefined,
      "t",
      '"id"',
    );

    expect(rows).toHaveLength(1200);
    const ids = rows.map((r) => r.id as number);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(1200);
    // More than one round-trip: the point is that no single statement returned
    // the whole table.
    expect(pool.statements.length).toBeGreaterThan(1);
    expect(Math.max(...pool.pageSizes)).toBeLessThanOrEqual(500);
  });

  test("every statement is ordered and bounded by a LIMIT", async () => {
    const pool = pagingPool(700);
    await fetchAgentScopedRowsBatched(
      pool as never,
      (keyset) => `SELECT * FROM "t" WHERE "agent_id" = $1 ${keyset}`,
      ["agent-1"],
      undefined,
      "t",
      '"id"',
    );
    for (const sql of pool.statements) {
      expect(sql).toMatch(/ORDER BY "id"/);
      expect(sql).toMatch(/LIMIT \d+/);
    }
    // Pages after the first must resume from the last id, not re-scan.
    expect(pool.statements.slice(1).every((s) => /"id" > \$2/.test(s))).toBe(
      true,
    );
  });

  test("an over-budget table is refused mid-walk, before the rest is read", async () => {
    const pool = pagingPool(5000);
    // A budget far smaller than the full table but bigger than one batch.
    const budget = new (class {
      private used = 0;
      check() {}
      chargeRaw(bytes: number) {
        this.used += bytes;
        if (this.used > 20_000) throw new Error("over budget");
      }
    })();

    await expect(
      fetchAgentScopedRowsBatched(
        pool as never,
        (keyset) => `SELECT * FROM "t" WHERE "agent_id" = $1 ${keyset}`,
        ["agent-1"],
        budget as never,
        "t",
        '"id"',
      ),
    ).rejects.toThrow("over budget");

    // Stopped early: it never issued the statements needed to read 5000 rows.
    expect(pool.statements.length).toBeLessThan(10);
  });
});
