import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  isMemoryPgliteDataDir,
  MEMORY_PGLITE_DATA_DIR,
} from "../src/runtime/database-selection.ts";
import {
  applyDatabaseConfigToEnv,
  resolveActivePgliteDataDir,
} from "../src/runtime/eliza.ts";

let directory: string;
const strayDirectory = () => path.resolve("memory:");
const DATABASE_ENV = [
  "PGLITE_DATA_DIR",
  "POSTGRES_URL",
  "DATABASE_URL",
  "ELIZA_DATABASE_PROVIDER",
  "SQLITE_DATABASE_PATH",
];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "pglite-memory-"));
  savedEnv = Object.fromEntries(
    DATABASE_ENV.map((name) => [name, process.env[name]]),
  );
  for (const name of DATABASE_ENV) delete process.env[name];
  vi.stubEnv("ELIZA_STATE_DIR", path.join(directory, "state"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

const workspace = () => path.join(directory, "state", "workspace");
const config = (dataDir?: string) => ({
  agents: { defaults: { workspace: workspace() } },
  ...(dataDir
    ? { database: { provider: "pglite" as const, pglite: { dataDir } } }
    : {}),
});

it("recognizes PGlite's in-memory settings and nothing else", () => {
  for (const value of [
    "memory://",
    " memory:// ",
    "memory://agent",
    ":memory:",
  ])
    expect(isMemoryPgliteDataDir(value)).toBe(true);
  for (const value of [
    undefined,
    null,
    "",
    "/data/.elizadb",
    "memory",
    "./memory:",
    "file://x",
  ])
    expect(isMemoryPgliteDataDir(value)).toBe(false);
});

it.each(["memory://", ":memory:"])(
  "configured %s keeps the database in memory and creates no directory",
  (dataDir) => {
    const strayBefore = fs.existsSync(strayDirectory());
    applyDatabaseConfigToEnv(config(dataDir));
    expect(process.env.PGLITE_DATA_DIR).toBe(MEMORY_PGLITE_DATA_DIR);
    expect(fs.existsSync(path.join(workspace(), ".elizadb"))).toBe(false);
    expect(fs.existsSync(strayDirectory())).toBe(strayBefore);
    expect(resolveActivePgliteDataDir(config(dataDir))).toBeNull();
  },
);

it("an in-memory PGLITE_DATA_DIR from the environment is not a path either", () => {
  vi.stubEnv("PGLITE_DATA_DIR", ":memory:");
  const strayBefore = fs.existsSync(strayDirectory());
  applyDatabaseConfigToEnv(config());
  expect(process.env.PGLITE_DATA_DIR).toBe(MEMORY_PGLITE_DATA_DIR);
  expect(fs.existsSync(path.join(workspace(), ".elizadb"))).toBe(false);
  expect(fs.existsSync(strayDirectory())).toBe(strayBefore);
  expect(resolveActivePgliteDataDir(config())).toBeNull();
});

it("the on-disk default is unchanged: a private <workspace>/.elizadb", () => {
  applyDatabaseConfigToEnv(config());
  const dataDir = path.join(workspace(), ".elizadb");
  expect(process.env.PGLITE_DATA_DIR).toBe(dataDir);
  expect(fs.statSync(dataDir).isDirectory()).toBe(true);
  if (process.platform !== "win32")
    expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700);
  expect(resolveActivePgliteDataDir(config())).toBe(dataDir);
});
