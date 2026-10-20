/**
 * Regression guard for #37089's in-memory PGlite rule in the backup
 * resolvers: `memory://` and `:memory:` are PGlite URLs, not paths. Resolving
 * them against the working directory mangles them into a `<cwd>/memory:`
 * directory, which silently defeated the filesystem guards in agent-backup —
 * a snapshot recorded an empty `pglite-files` database component, and
 * capture v2 failed with a directory-identity error for a bogus path.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createAgentSnapshot,
  createDefaultAgentBackupV2CaptureSources,
} from "../src/services/agent-backup.ts";

let directory: string;
let stateDir: string;
const ENV_KEYS = [
  "ELIZA_STATE_DIR",
  "PGLITE_DATA_DIR",
  "POSTGRES_URL",
  "DATABASE_URL",
];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "backup-memory-pglite-"));
  stateDir = path.join(directory, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  savedEnv = Object.fromEntries(
    ENV_KEYS.map((name) => [name, process.env[name]]),
  );
  vi.stubEnv("ELIZA_STATE_DIR", stateDir);
  vi.stubEnv("POSTGRES_URL", undefined);
  vi.stubEnv("DATABASE_URL", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

// A runtime with no managed PGlite dump exporter: the legacy capture falls
// back to the file-set path, which is the path the in-memory guard protects.
const runtime = {
  agentId: "00000000-0000-4000-8000-000000000409",
  character: { name: "Backup memory test" },
  adapter: {},
  getSetting: () => undefined,
} as never;
const config = {} as never;

for (const spelling of ["memory://", ":memory:"]) {
  it(`records no database component for an in-memory PGlite setting (${spelling})`, async () => {
    vi.stubEnv("PGLITE_DATA_DIR", spelling);
    const snapshot = await createAgentSnapshot(runtime, config);
    const database = snapshot.manifest.components.database;
    expect(database.kind).toBe("none");
    expect(database.reason).toBe(
      `PGlite data dir ${spelling} is not a filesystem directory`,
    );
  });

  it(`refuses capture v2 for an in-memory PGlite setting (${spelling})`, () => {
    vi.stubEnv("PGLITE_DATA_DIR", spelling);
    expect(() =>
      createDefaultAgentBackupV2CaptureSources(runtime, config),
    ).toThrow(
      expect.objectContaining({
        code: "AGENT_BACKUP_V2_PGLITE_NOT_FILESYSTEM",
      }),
    );
  });
}

it("still captures a real on-disk PGlite directory as a file set", async () => {
  const pgliteDir = path.join(directory, ".elizadb");
  fs.mkdirSync(pgliteDir, { recursive: true });
  fs.writeFileSync(path.join(pgliteDir, "PG_VERSION"), "16\n");
  vi.stubEnv("PGLITE_DATA_DIR", pgliteDir);
  const snapshot = await createAgentSnapshot(runtime, config);
  const database = snapshot.manifest.components.database;
  expect(database.kind).toBe("pglite-files");
  expect(database.pglite?.files.map((file) => file.path)).toEqual([
    "PG_VERSION",
  ]);
});
