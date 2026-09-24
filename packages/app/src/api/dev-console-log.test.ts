import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { readDevConsoleLogTail } from "./dev-console-log";

it("reads the requested tail but rejects a log symlink outside the state directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "app-log-tail-"));
  const stateDir = join(directory, "state");
  mkdirSync(stateDir);
  vi.stubEnv("ELIZA_STATE_DIR", stateDir);
  try {
    const log = join(stateDir, "desktop-dev-console.log");
    writeFileSync(log, "first\nsecond\nlast\n");
    expect(readDevConsoleLogTail(log, { maxLines: 2 })).toEqual({
      ok: true,
      body: "second\nlast\n",
    });
    const outside = join(directory, "outside.log");
    writeFileSync(outside, "outside-state");
    rmSync(log);
    symlinkSync(outside, log);
    expect(readDevConsoleLogTail(log)).toEqual({
      ok: false,
      error: "log path is outside the state directory",
    });
  } finally {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});
