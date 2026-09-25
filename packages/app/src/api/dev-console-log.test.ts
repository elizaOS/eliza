import fs, {
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

it.each([Number.NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid tail limits %s before reading a file",
  (value) => {
    for (const key of ["maxLines", "maxBytes"]) {
      expect(readDevConsoleLogTail("missing", { [key]: value })).toEqual({
        ok: false,
        error: `${key} must be a finite safe integer`,
      });
    }
  },
);

it("continues short reads and never returns unread buffer bytes after truncation", () => {
  const directory = mkdtempSync(join(tmpdir(), "app-log-short-read-"));
  vi.stubEnv("ELIZA_STATE_DIR", directory);
  const log = join(directory, "desktop-dev-console.log");
  const read = fs.readSync;
  try {
    writeFileSync(log, "first\nsecond\nlast\n");
    const spy = vi
      .spyOn(fs, "readSync")
      .mockImplementation((fd, buffer, options = {}) =>
        read(fd, buffer, {
          ...options,
          length: Math.min(options.length ?? buffer.byteLength, 4),
        }),
      );
    expect(readDevConsoleLogTail(log, { maxLines: 2 })).toEqual({
      ok: true,
      body: "second\nlast\n",
    });
    expect(spy.mock.calls.length).toBeGreaterThan(1);
    let firstRead = true;
    spy.mockImplementation((fd, buffer, options) => {
      if (firstRead) {
        firstRead = false;
        fs.truncateSync(log, 6);
      }
      return read(fd, buffer, options);
    });
    expect(readDevConsoleLogTail(log)).toEqual({ ok: true, body: "first\n" });
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});
