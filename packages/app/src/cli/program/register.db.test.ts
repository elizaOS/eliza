import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

const loadElizaConfig = vi.fn();

vi.mock("@elizaos/agent", async () => {
  const eliza = await vi.importActual<
    typeof import("@elizaos/agent/runtime/eliza")
  >("@elizaos/agent/runtime/eliza");
  return {
    loadElizaConfig,
    resolveActivePgliteDataDir: eliza.resolveActivePgliteDataDir,
  };
});

const { registerDbCommand } = await import("./register.db");

let tmp: string;
const savedEnv = { ...process.env };

// register.db lazily imports @elizaos/agent, whose runtime module is large to
// transform on a cold cache; load it once here so each case measures only the
// reset behavior.
beforeAll(async () => {
  await import("@elizaos/agent");
}, 600_000);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-db-reset-"));
  process.env.ELIZA_STATE_DIR = path.join(tmp, "state");
  delete process.env.PGLITE_DATA_DIR;
  delete process.env.POSTGRES_URL;
  delete process.env.DATABASE_URL;
  delete process.env.SQLITE_DATABASE_PATH;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...savedEnv };
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
  loadElizaConfig.mockReset();
});

async function reset() {
  const program = new Command();
  registerDbCommand(program);
  await program.parseAsync(["node", "eliza", "db", "reset", "--yes"]);
}

function seed(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "PG_VERSION"), "16");
  fs.mkdirSync(path.join(dir, "global"));
  fs.writeFileSync(
    path.join(dir, "global", "pg_control"),
    "fixture control data",
  );
  return dir;
}

it("resets the PGlite dir from config.database.pglite.dataDir, not the state default", async () => {
  const configured = seed(path.join(tmp, "custom-db"));
  const stateDefault = seed(path.join(tmp, "state", "workspace", ".elizadb"));
  loadElizaConfig.mockReturnValue({
    database: { provider: "pglite", pglite: { dataDir: configured } },
  });
  await reset();
  expect(fs.existsSync(configured)).toBe(false);
  expect(fs.existsSync(stateDefault)).toBe(true);
});

it("resets the PGLITE_DATA_DIR override", async () => {
  const envDir = seed(path.join(tmp, "env-db"));
  process.env.PGLITE_DATA_DIR = envDir;
  loadElizaConfig.mockReturnValue({});
  await reset();
  expect(fs.existsSync(envDir)).toBe(false);
});

it("resets <agents.defaults.workspace>/.elizadb when the workspace is overridden", async () => {
  const workspace = path.join(tmp, "ws");
  const dbDir = seed(path.join(workspace, ".elizadb"));
  loadElizaConfig.mockReturnValue({
    agents: { defaults: { workspace } },
  });
  await reset();
  expect(fs.existsSync(dbDir)).toBe(false);
});

it("refuses to reset when the configured provider is postgres", async () => {
  const stateDefault = seed(path.join(tmp, "state", "workspace", ".elizadb"));
  loadElizaConfig.mockReturnValue({ database: { provider: "postgres" } });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation(() => undefined as never);
  await reset();
  expect(fs.existsSync(stateDefault)).toBe(true);
  expect(error).toHaveBeenCalledWith(
    expect.stringContaining("only resets the local PGlite database"),
  );
  expect(exit).toHaveBeenCalledWith(1);
});

it.each(["unrelated directory", "symlink"])(
  "refuses a configured %s without deleting user files",
  async (kind) => {
    const target = path.join(tmp, "user-files");
    fs.mkdirSync(target);
    const sentinel = path.join(target, "important.txt");
    fs.writeFileSync(sentinel, "preserve me");
    let configured = target;
    if (kind === "symlink") {
      seed(target);
      configured = path.join(tmp, "db-link");
      fs.symlinkSync(target, configured, "dir");
    }
    loadElizaConfig.mockReturnValue({
      database: { provider: "pglite", pglite: { dataDir: configured } },
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    await reset();
    expect(fs.readFileSync(sentinel, "utf8")).toBe("preserve me");
    expect(fs.existsSync(configured)).toBe(true);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Refusing to reset"),
    );
    expect(exit).toHaveBeenCalledWith(1);
  },
);
