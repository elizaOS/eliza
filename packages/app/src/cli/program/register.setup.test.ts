import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerSetupCommand } from "./register.setup";

const ENV_KEYS = [
  "ELIZA_STATE_DIR",
  "ELIZA_CONFIG_PATH",
  "ELIZA_PERSIST_CONFIG_PATH",
  "OPENAI_API_KEY",
] as const;
let root: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  root = mkdtempSync(path.join(os.tmpdir(), "eliza-setup-"));
  process.env.ELIZA_STATE_DIR = path.join(root, "state");
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(root, { recursive: true, force: true });
});

async function setup() {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const program = new Command();
  registerSetupCommand(program);
  await program.parseAsync([
    "node",
    "eliza",
    "setup",
    "--provider",
    "openai",
    "--key",
    "sk-test",
    "--no-wizard",
    "--workspace",
    path.join(root, "workspace"),
  ]);
  expect(error).not.toHaveBeenCalled();
}

function readEnvSection(file: string): Record<string, unknown> {
  return (JSON.parse(readFileSync(file, "utf8")) as { env: never }).env;
}

it("persists the provider key through saveElizaConfig with owner-only permissions", async () => {
  await setup();
  const configPath = path.join(root, "state", "eliza.json");
  expect(readEnvSection(configPath)).toMatchObject({
    OPENAI_API_KEY: "sk-test",
  });
  if (process.platform !== "win32") {
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  }
});

it("writes to the configured persist path like the runtime does", async () => {
  const persistPath = path.join(root, "persist", "eliza.json");
  process.env.ELIZA_PERSIST_CONFIG_PATH = persistPath;
  await setup();
  expect(readEnvSection(persistPath)).toMatchObject({
    OPENAI_API_KEY: "sk-test",
  });
  expect(existsSync(path.join(root, "state", "eliza.json"))).toBe(false);
});
