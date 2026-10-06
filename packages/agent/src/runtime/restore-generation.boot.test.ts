/** Exercises committed-generation selection, real runtime boots, and authenticated HTTP restart failure without ordinary-boot fallback. */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { AgentRuntime } from "@elizaos/core";
import { type SQL, sql } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import * as apiServer from "../api/server.ts";
import * as sandboxRegistry from "../sandbox-registry.ts";
import {
  type AgentBackupRestoreV3CandidateFs,
  openAgentBackupRestoreV3CandidateFs,
} from "../services/agent-backup-restore-v3-candidate-fs";
import { candidateFsCanonicalJson } from "../services/agent-backup-restore-v3-candidate-fs-json";
import type { AgentBackupRestoreV3PreparedGenerationReceipt } from "../services/agent-backup-restore-v3-generation";
import { commitAgentBackupRestoreV3Generation } from "../services/agent-backup-restore-v3-generation-commit";
import { AgentBackupRestoreV3RuntimeGeneration } from "../services/agent-backup-restore-v3-runtime-generation";
import { buildInitializedRuntime, shutdownRuntime, startEliza } from "./eliza";
import {
  _resetAgentHostBridge,
  defaultAgentHostBridge,
  setAgentHostBridge,
} from "./host-bridge";

/** Load-tolerant wall-clock test budget; no deadline here proves expiry. */
const TEST_BUDGET_MS = 10 * 60_000;
vi.setConfig({ testTimeout: TEST_BUDGET_MS, hookTimeout: TEST_BUDGET_MS });

const roots = new Set<string>();
const candidates = new Set<AgentBackupRestoreV3CandidateFs>();
const authorities = new Set<AgentBackupRestoreV3RuntimeGeneration>();
const control = () => ({
  signal: new AbortController().signal,
  deadlineEpochMs: Date.now() + TEST_BUDGET_MS,
});
async function fixture() {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "restore-runtime-"),
  );
  roots.add(root);
  const trustedRoot = path.join(root, "private");
  const attemptRoot = path.join(trustedRoot, "attempt");
  const runtimeRoot = path.join(root, "runtime");
  for (const dir of [
    path.join(attemptRoot, "generation/character"),
    path.join(attemptRoot, "generation/state"),
    runtimeRoot,
  ])
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const agentId = randomUUID();
  const character = {
    id: agentId,
    name: "Exact restored persona",
    bio: ["The lighthouse is amber"],
    system: "Retain this exact restored system.",
    templates: { messageHandlerTemplate: "Restored template" },
    plugins: [],
  };
  await fs.writeFile(
    path.join(attemptRoot, "generation/character/character.json"),
    JSON.stringify(character),
    { mode: 0o600 },
  );
  const db = new PGlite(path.join(attemptRoot, "generation/database"));
  try {
    await db.exec(
      "CREATE TABLE boot_fact (fact text); INSERT INTO boot_fact VALUES ('amber lighthouse')",
    );
  } finally {
    await db.close();
  }
  // PGlite-created directories are tightened for the private quarantine contract.
  const tighten = async (dir: string): Promise<void> => {
    await fs.chmod(dir, 0o700);
    for (const entry of await fs.readdir(dir, { withFileTypes: true }))
      if (entry.isDirectory()) await tighten(path.join(dir, entry.name));
  };
  await tighten(path.join(attemptRoot, "generation/database"));
  const generationFs = await openAgentBackupRestoreV3CandidateFs({
    trustedRoot,
    attemptRoot,
    control: control(),
    ...(process.platform === "linux"
      ? {}
      : { testOnlyAllowNonLinuxFdEmulation: true as const }),
  });
  candidates.add(generationFs);
  const lock = await generationFs.acquireLock(
    ".restore-v3-generation.lock",
    control(),
  );
  let preparedReceipt: AgentBackupRestoreV3PreparedGenerationReceipt;
  try {
    const tree = await generationFs.inspectFileTree(
      "generation",
      control(),
      lock,
    );
    const body = {
      version: 1 as const,
      format: "elizaos.agent-backup.restore-v3-generation-prepared.v1" as const,
      assemblySha256: "a".repeat(64),
      sourceTreeSha256: "b".repeat(64),
      targetRoot: generationFs.attemptRootIdentity,
      paths: {
        character: "generation/character/character.json" as const,
        database: "generation/database" as const,
        state: "generation/state" as const,
      },
      treeSha256: tree.sha256,
      files: tree.files,
      directories: tree.directories,
      bytes: tree.bytes,
    };
    preparedReceipt = {
      ...body,
      receiptSha256: createHash("sha256")
        .update(candidateFsCanonicalJson(body))
        .digest("hex"),
    };
    await generationFs.publishDurableJson(
      ".restore-v3-generation-prepared.json",
      preparedReceipt,
      { maximumBytes: 16384 },
      control(),
      lock,
    );
  } finally {
    await lock.release(control());
  }
  const parent = await fs.stat(runtimeRoot, { bigint: true });
  const input = {
    generationFs,
    preparedReceipt,
    runtimeRoot,
    runtimeRootIdentity: {
      device: String(parent.dev),
      inode: String(parent.ino),
    },
    control: control(),
  };
  return { input, agentId, character };
}
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  _resetAgentHostBridge();
  for (const authority of authorities) await authority.close();
  authorities.clear();
  for (const candidate of candidates) await candidate.close();
  candidates.clear();
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  roots.clear();
});

it(
  "does not boot or promote an unfinished generation and rejects a missing physical database",
  async () => {
    const { input, agentId } = await fixture();
    await expect(
      AgentBackupRestoreV3RuntimeGeneration.open(input, agentId),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_GENERATION_COMMIT_NOT_COMMITTED",
    });
    expect(await fs.readdir(input.runtimeRoot)).toEqual([]);
    const committed = await commitAgentBackupRestoreV3Generation(input);
    await fs.unlink(path.join(committed.paths.database, "PG_VERSION"));
    await expect(
      AgentBackupRestoreV3RuntimeGeneration.open(
        { ...input, control: control() },
        agentId,
      ),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(committed.paths.database, "PG_VERSION")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
  TEST_BUDGET_MS,
);

it(
  "retains restore authority across server restarts without self-registering routes",
  async () => {
    const { input, agentId } = await fixture();
    const committed = await commitAgentBackupRestoreV3Generation(input);
    const authority = await AgentBackupRestoreV3RuntimeGeneration.open(
      { ...input, control: control() },
      agentId,
    );
    authorities.add(authority);
    vi.stubEnv("ELIZA_STATE_DIR", committed.paths.state);
    vi.stubEnv("PGLITE_DATA_DIR", committed.paths.database);
    for (const key of [
      "POSTGRES_URL",
      "DATABASE_URL",
      "SANDBOX_ROUTE_AGENT_ID",
    ])
      vi.stubEnv(key, undefined);
    vi.stubEnv("ELIZA_DISABLE_VAULT_PROFILE_RESOLVER", "1");
    vi.stubEnv(
      "ELIZA_OPTIMIZED_PROMPT_HMAC_KEY",
      Buffer.alloc(32, 1).toString("base64"),
    );
    setAgentHostBridge({
      ...defaultAgentHostBridge,
      sharedVault: () => ({
        ...defaultAgentHostBridge.sharedVault(),
        has: async () => false,
      }),
    });
    const registry = vi.spyOn(sandboxRegistry, "buildSandboxRegistryFromEnv");
    const abort = new AbortController();
    let server:
      | Awaited<ReturnType<typeof apiServer.startApiServer>>
      | undefined;
    const token = randomUUID();
    vi.stubEnv("ELIZA_API_BIND_HOST", "127.0.0.1");
    vi.stubEnv("ELIZA_API_TOKEN", token);
    vi.stubEnv("ELIZA_REQUIRE_LOCAL_AUTH", "1");
    vi.stubEnv(
      "ELIZA_CONFIG_PATH",
      path.join(committed.paths.state, "eliza.json"),
    );
    vi.stubEnv(
      "ELIZA_PERSIST_CONFIG_PATH",
      path.join(committed.paths.state, "eliza.json"),
    );
    let runtime: AgentRuntime | undefined;
    const startServer = apiServer.startApiServer;
    const start = vi
      .spyOn(apiServer, "startApiServer")
      .mockImplementation(async (options) => {
        server = await startServer({
          ...options,
          port: 0,
          skipDeferredStartupWork: true,
        });
        abort.abort();
        return server;
      });
    try {
      const started = await startEliza({
        serverOnly: true,
        restoredGeneration: authority,
        configOverride: {
          agents: {
            defaults: {
              workspace: path.join(committed.paths.state, "workspace"),
            },
          },
        },
        abortSignal: abort.signal,
        onRuntimeCreated: (created) => {
          runtime = created;
        },
      });
      expect(started).toBe(runtime);
      expect(started?.agentId).toBe(agentId);
      expect(start).toHaveBeenCalledOnce();
      expect(registry).not.toHaveBeenCalled();
      if (!server) throw new Error("HTTP server did not start");
      const restartUrl = `http://127.0.0.1:${server.port}/api/agent/restart`;
      const restart = (authenticated: boolean) =>
        fetch(restartUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-forwarded-for": "203.0.113.10",
            ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: "{}",
        });
      expect((await restart(false)).status).toBe(401);
      await authority.close();
      const failed = await restart(true);
      expect(failed.status).toBe(500);
      expect(await failed.json()).toMatchObject({
        error: expect.stringContaining("runtime failed to re-initialize"),
      });
      expect(registry).not.toHaveBeenCalled();
      const db = new PGlite(committed.paths.database);
      try {
        expect((await db.query("SELECT fact FROM boot_fact")).rows).toEqual([
          { fact: "amber lighthouse" },
        ]);
      } finally {
        await db.close();
      }
    } finally {
      abort.abort();
      await server?.close();
      await shutdownRuntime(runtime, "restore server fixture cleanup", {
        fast: true,
      });
    }
  },
  TEST_BUDGET_MS,
);

it(
  "initializes and restarts the real runtime on the committed database without losing later writes",
  async () => {
    const { input, agentId, character } = await fixture();
    const committed = await commitAgentBackupRestoreV3Generation(input);
    vi.stubEnv("ELIZA_STATE_DIR", committed.paths.state);
    vi.stubEnv("PGLITE_DATA_DIR", committed.paths.database);
    for (const key of [
      "POSTGRES_URL",
      "DATABASE_URL",
      "SANDBOX_ROUTE_AGENT_ID",
      "ELIZA_CANONICAL_BOOT_ROOT",
      "ELIZA_CANONICAL_BOOT_MANIFEST",
    ])
      vi.stubEnv(key, undefined);
    vi.stubEnv(
      "ELIZA_AGENT_CHARACTER_JSON",
      JSON.stringify({ id: randomUUID(), name: "Wrong env persona" }),
    );
    vi.stubEnv("ELIZA_DISABLE_VAULT_PROFILE_RESOLVER", "1");
    vi.stubEnv(
      "ELIZA_OPTIMIZED_PROMPT_HMAC_KEY",
      Buffer.alloc(32, 1).toString("base64"),
    );
    setAgentHostBridge({
      ...defaultAgentHostBridge,
      sharedVault: () => ({
        ...defaultAgentHostBridge.sharedVault(),
        has: async () => false,
      }),
    });
    for (let boot = 0; boot < 2; boot += 1) {
      // Each boot reopens the durable handoff, including after live database writes.
      const authority = await AgentBackupRestoreV3RuntimeGeneration.open(
        { ...input, control: control() },
        agentId,
      );
      authorities.add(authority);
      const abort = new AbortController();
      let constructed: AgentRuntime | undefined;
      const created = vi.fn((runtime: AgentRuntime) => {
        constructed = runtime;
        expect(runtime.agentId).toBe(agentId);
        expect(runtime.character.name).toBe(character.name);
        expect(runtime.character.system).toBe(character.system);
        expect(runtime.character.templates).toEqual(character.templates);
        expect(process.env.PGLITE_DATA_DIR).toBe(committed.paths.database);
      });
      try {
        const bootOptions = {
          restoredGeneration: authority,
          abortSignal: abort.signal,
          onRuntimeCreated: created,
          onBootPhase: (phase: string) => {
            if (phase === "attach-host")
              throw new Error("stop after runtime initialization");
          },
        };
        const config = {
          agents: {
            defaults: {
              workspace: path.join(committed.paths.state, "workspace"),
            },
          },
          ui: { assistant: { name: "Wrong config persona" } },
        };
        await expect(
          boot === 0
            ? startEliza({
                ...bootOptions,
                headless: true,
                configOverride: config,
              })
            : buildInitializedRuntime({ ...bootOptions, config }),
        ).rejects.toThrow("stop after runtime initialization");
        expect(created).toHaveBeenCalledOnce();
        if (!constructed) throw new Error("Runtime was not constructed");
        const adapter = constructed.db as {
          execute: (query: SQL) => Promise<unknown>;
        };
        const rows = await adapter.execute(
          sql`SELECT fact FROM boot_fact ORDER BY fact`,
        );
        expect(rows).toMatchObject({
          rows:
            boot === 0
              ? [{ fact: "amber lighthouse" }]
              : [{ fact: "amber lighthouse" }, { fact: "new runtime fact" }],
        });
        if (boot === 0)
          await adapter.execute(
            sql`INSERT INTO boot_fact VALUES ('new runtime fact')`,
          );
      } finally {
        abort.abort();
        await shutdownRuntime(constructed, "restore boot fixture cleanup", {
          fast: true,
        });
        await authority.close();
      }
    }
    const db = new PGlite(committed.paths.database);
    try {
      expect(
        (await db.query("SELECT fact FROM boot_fact ORDER BY fact")).rows,
      ).toEqual([{ fact: "amber lighthouse" }, { fact: "new runtime fact" }]);
    } finally {
      await db.close();
    }
  },
  TEST_BUDGET_MS,
);

it(
  "rejects conflicting identity, config and replaced directories before runtime construction",
  async () => {
    const { input, agentId } = await fixture();
    const committed = await commitAgentBackupRestoreV3Generation(input);
    await expect(
      AgentBackupRestoreV3RuntimeGeneration.open(
        { ...input, control: control() },
        randomUUID(),
      ),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_BOOT_CHARACTER_INVALID",
    });
    const authority = await AgentBackupRestoreV3RuntimeGeneration.open(
      { ...input, control: control() },
      agentId,
    );
    authorities.add(authority);
    const created = vi.fn();
    const options = {
      headless: true,
      restoredGeneration: authority,
      onRuntimeCreated: created,
      configOverride: {},
    };
    vi.stubEnv("ELIZA_STATE_DIR", committed.paths.state);
    vi.stubEnv("PGLITE_DATA_DIR", committed.paths.database);
    vi.stubEnv("DATABASE_URL", undefined);
    vi.stubEnv("POSTGRES_URL", undefined);
    vi.stubEnv("SANDBOX_ROUTE_AGENT_ID", agentId);
    vi.stubEnv("ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS", undefined);
    expect(() =>
      authority.configure({ database: { provider: "postgres" } }),
    ).toThrow();
    expect(() =>
      authority.configure({
        env: { vars: { ELIZA_STATE_DIR: "/not-restored" } },
      }),
    ).toThrow();
    vi.stubEnv("PGLITE_DATA_DIR", "/not-restored");
    // A truthy-but-unauthorized value must not fire the destructive-migration
    // guard; boot reaches the real database conflict instead.
    vi.stubEnv("ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS", "1");
    await expect(startEliza(options)).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_BOOT_DATABASE_CONFLICT",
    });
    vi.stubEnv("ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS", undefined);
    await expect(startEliza(options)).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_BOOT_DATABASE_CONFLICT",
    });
    vi.stubEnv("PGLITE_DATA_DIR", committed.paths.database);
    vi.stubEnv("SANDBOX_ROUTE_AGENT_ID", randomUUID());
    await expect(startEliza(options)).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_BOOT_IDENTITY_CONFLICT",
    });
    vi.stubEnv("SANDBOX_ROUTE_AGENT_ID", agentId);
    // The restore authority guard rejects only the exact documented value.
    vi.stubEnv("ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS", "1");
    expect(() => authority.assertEnvironment()).not.toThrow();
    vi.stubEnv("ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS", "yes");
    expect(() => authority.assertEnvironment()).not.toThrow();
    vi.stubEnv("ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS", "true");
    let destructiveFailure: unknown;
    try {
      authority.assertEnvironment();
    } catch (error) {
      destructiveFailure = error;
    }
    expect(destructiveFailure).toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_BOOT_DESTRUCTIVE_MIGRATION_FORBIDDEN",
    });
    vi.stubEnv("ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS", "true");
    await expect(startEliza(options)).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_BOOT_DESTRUCTIVE_MIGRATION_FORBIDDEN",
    });
    vi.stubEnv("ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS", undefined);
    const original = `${committed.paths.database}-original`;
    await fs.rename(committed.paths.database, original);
    await fs.mkdir(committed.paths.database, { mode: 0o700 });
    await expect(startEliza(options)).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_BOOT_DIRECTORY_CHANGED",
    });
    expect(await fs.readdir(committed.paths.database)).toEqual([]);
    expect(created).not.toHaveBeenCalled();
    await authority.close();
    await expect(
      buildInitializedRuntime({
        config: {},
        restoredGeneration: authority,
        onRuntimeCreated: created,
      }),
    ).rejects.toMatchObject({ code: "AGENT_BACKUP_RESTORE_V3_BOOT_CLOSED" });
    expect(created).not.toHaveBeenCalled();
  },
  TEST_BUDGET_MS,
);
