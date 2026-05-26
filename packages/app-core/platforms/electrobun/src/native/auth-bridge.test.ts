import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger";
import {
  loadPersistedSession,
  resolveAuthDir,
  resolveSessionPath,
} from "./auth-bridge";

vi.mock("../logger", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
}));

const tempRoots: string[] = [];

function createStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-auth-bridge-"));
  tempRoots.push(dir);
  return dir;
}

describe("desktop auth bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const dir of tempRoots.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("logs malformed persisted desktop sessions before falling through", () => {
    const stateDir = createStateDir();
    const env = { ELIZA_STATE_DIR: stateDir };
    fs.mkdirSync(resolveAuthDir(env), { recursive: true });
    const sessionPath = resolveSessionPath(env);
    fs.writeFileSync(sessionPath, "{", "utf8");

    expect(loadPersistedSession(env, () => 1_700_000_000_000)).toBeNull();

    expect(logger.warn).toHaveBeenCalledWith(
      "[DesktopAuthBridge] Failed to parse persisted desktop session",
      expect.objectContaining({
        sessionPath,
        error: expect.any(String),
      }),
    );
  });

  it("treats a missing persisted desktop session as normal first-run state", () => {
    const stateDir = createStateDir();
    const env = { ELIZA_STATE_DIR: stateDir };

    expect(loadPersistedSession(env, () => 1_700_000_000_000)).toBeNull();

    expect(logger.warn).not.toHaveBeenCalled();
  });
});
