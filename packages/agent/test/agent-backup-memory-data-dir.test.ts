/** An agent on PGlite's in-memory data dir (`memory://`) has no database directory: capture records `database.kind: "none"` and a PGlite restore is refused instead of writing a stray `memory:` directory and reporting success. */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ElizaConfig } from "@elizaos/host/protocol";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  type AgentBackupStateData,
  createAgentSnapshot,
  restoreAgentSnapshot,
} from "../src/services/agent-backup.ts";

let directory: string;
let fileBacked: Awaited<ReturnType<typeof createTestRuntime>>;
let inMemory: Awaited<ReturnType<typeof createTestRuntime>>;
let config: ElizaConfig;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "agent-backup-memory-"));
  const stateDir = path.join(directory, "state");
  const pgliteDir = path.join(directory, ".elizadb");
  for (const child of ["media", "models"])
    await mkdir(path.join(stateDir, child), { recursive: true });
  await writeFile(path.join(stateDir, "vault.json"), "{}");
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: stateDir,
    ELIZA_CONFIG_PATH: path.join(stateDir, "eliza.json"),
    ELIZA_PERSIST_CONFIG_PATH: path.join(stateDir, "eliza.json"),
  }))
    vi.stubEnv(key, value);
  for (const key of ["POSTGRES_URL", "DATABASE_URL", "ELIZA_DATABASE_PROVIDER"])
    vi.stubEnv(key, undefined);
  config = {
    agents: { defaults: { workspace: stateDir } },
  } as ElizaConfig;
  vi.stubEnv("PGLITE_DATA_DIR", pgliteDir);
  fileBacked = await createTestRuntime({
    characterName: "Backup memory-mode agent",
    pgliteDir,
    settings: { LOAD_DOCS_ON_STARTUP: false },
  });
  vi.stubEnv("PGLITE_DATA_DIR", "memory://");
  inMemory = await createTestRuntime({
    characterName: "Backup memory-mode agent",
    settings: { LOAD_DOCS_ON_STARTUP: false },
  });
  expect(inMemory.pgliteDir.startsWith("memory://")).toBe(true);
}, 180_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await inMemory?.cleanup();
  await fileBacked?.cleanup();
  await rm(directory, { recursive: true, force: true });
});

it("captures a snapshot without a database component for an in-memory agent", async () => {
  vi.stubEnv("PGLITE_DATA_DIR", "memory://");
  const snapshot = await createAgentSnapshot(inMemory.runtime, config);
  expect(snapshot.manifest.components.database.kind).toBe("none");
}, 120_000);

it("refuses to restore a PGlite dump into an in-memory agent", async () => {
  vi.stubEnv("PGLITE_DATA_DIR", path.join(directory, ".elizadb"));
  const snapshot: AgentBackupStateData = await createAgentSnapshot(
    fileBacked.runtime,
    config,
  );
  expect(snapshot.manifest.components.database.kind).toBe("pglite-dump");
  vi.stubEnv("PGLITE_DATA_DIR", "memory://");
  await expect(
    restoreAgentSnapshot(inMemory.runtime, snapshot),
  ).rejects.toThrow(/non-filesystem data dir memory:\/\//);
}, 120_000);
