/**
 * Tests for the dev-console-log path guard (#8801 / #9943): isAllowedDevConsole
 * LogPath gates a file READ exposed over the dev API, so without it a traversal
 * could read arbitrary files. Only `desktop-dev-console.log` UNDER the resolved
 * state dir (incl. nested) is allowed; wrong basenames, paths outside the state
 * dir, and `..` escapes are rejected.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isAllowedDevConsoleLogPath } from "./dev-console-log";

describe("isAllowedDevConsoleLogPath", () => {
  let stateDir: string;
  const prev = process.env.ELIZA_STATE_DIR;

  beforeAll(() => {
    stateDir = realpathSync(mkdtempSync(join(tmpdir(), "devconsole-state-")));
    process.env.ELIZA_STATE_DIR = stateDir;
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.ELIZA_STATE_DIR;
    else process.env.ELIZA_STATE_DIR = prev;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("allows the dev-console log under the state dir (incl. nested)", () => {
    expect(
      isAllowedDevConsoleLogPath(join(stateDir, "desktop-dev-console.log")),
    ).toBe(true);
    expect(
      isAllowedDevConsoleLogPath(
        join(stateDir, "logs", "desktop-dev-console.log"),
      ),
    ).toBe(true);
  });

  it("rejects a wrong basename", () => {
    expect(isAllowedDevConsoleLogPath(join(stateDir, "secrets.log"))).toBe(
      false,
    );
    expect(
      isAllowedDevConsoleLogPath(join(stateDir, "desktop-dev-console.log.bak")),
    ).toBe(false);
  });

  it("rejects a path outside the state dir", () => {
    expect(isAllowedDevConsoleLogPath("/etc/desktop-dev-console.log")).toBe(
      false,
    );
  });

  it("rejects a traversal that escapes the state dir", () => {
    expect(
      isAllowedDevConsoleLogPath(
        join(stateDir, "..", "desktop-dev-console.log"),
      ),
    ).toBe(false);
  });
});
