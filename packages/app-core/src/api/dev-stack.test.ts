import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveDevStackFromEnv } from "./dev-stack";

const ENV_KEYS = ["ELIZA_STATE_DIR"] as const;

let savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;
let stateDir: string | undefined;

beforeEach(async () => {
  savedEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as typeof savedEnv;
  stateDir = await mkdtemp(path.join(tmpdir(), "eliza-dev-stack-"));
  process.env.ELIZA_STATE_DIR = stateDir;
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (stateDir) {
    await rm(stateDir, { recursive: true, force: true });
    stateDir = undefined;
  }
});

describe("resolveDevStackFromEnv", () => {
  it("advertises the console-log tail only for allowed desktop dev log paths", () => {
    if (!stateDir) throw new Error("stateDir was not initialized");

    const allowedPath = path.join(stateDir, "desktop-dev-console.log");
    expect(
      resolveDevStackFromEnv({
        ELIZA_DESKTOP_DEV_LOG_PATH: allowedPath,
      }).desktopDevLog,
    ).toEqual({
      filePath: allowedPath,
      apiTailPath: "/api/dev/console-log",
    });

    expect(
      resolveDevStackFromEnv({
        ELIZA_DESKTOP_DEV_LOG_PATH: path.join(stateDir, "secrets.log"),
      }).desktopDevLog,
    ).toEqual({
      filePath: path.join(stateDir, "secrets.log"),
      apiTailPath: null,
    });
  });
});
