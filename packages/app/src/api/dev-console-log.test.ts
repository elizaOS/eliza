/**
 * Unit tests for the GET /api/dev/console-log tail helpers. Drives
 * `isAllowedDevConsoleLogPath` and `readDevConsoleLogTail` against a real temp
 * state dir and real files — no mocks of the module under test.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isAllowedDevConsoleLogPath,
  readDevConsoleLogTail,
} from "./dev-console-log";

describe("dev-console-log", () => {
  let stateDir: string;
  const prevStateDir = process.env.ELIZA_STATE_DIR;

  beforeAll(() => {
    stateDir = realpathSync(mkdtempSync(join(tmpdir(), "dev-console-log-")));
    process.env.ELIZA_STATE_DIR = stateDir;
  });

  afterAll(() => {
    if (prevStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
    else process.env.ELIZA_STATE_DIR = prevStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  });

  describe("isAllowedDevConsoleLogPath", () => {
    it("allows the canonical log basename directly under the state dir", () => {
      expect(
        isAllowedDevConsoleLogPath(join(stateDir, "desktop-dev-console.log")),
      ).toBe(true);
    });

    it("allows a nested path that still uses the canonical basename", () => {
      expect(
        isAllowedDevConsoleLogPath(
          join(stateDir, "logs", "nested", "desktop-dev-console.log"),
        ),
      ).toBe(true);
    });

    it("allows a path that normalizes via `.` segments onto the canonical file", () => {
      expect(
        isAllowedDevConsoleLogPath(
          join(stateDir, ".", "desktop-dev-console.log"),
        ),
      ).toBe(true);
    });

    it("rejects a wrong basename under the state dir", () => {
      expect(isAllowedDevConsoleLogPath(join(stateDir, "secrets.log"))).toBe(
        false,
      );
      expect(
        isAllowedDevConsoleLogPath(
          join(stateDir, "desktop-dev-console.log.bak"),
        ),
      ).toBe(false);
      expect(
        isAllowedDevConsoleLogPath(join(stateDir, "desktop-dev-console")),
      ).toBe(false);
    });

    it("rejects an empty path and a bare relative basename", () => {
      expect(isAllowedDevConsoleLogPath("")).toBe(false);
      expect(isAllowedDevConsoleLogPath("desktop-dev-console.log")).toBe(false);
    });

    it("rejects the canonical basename outside the state dir", () => {
      expect(isAllowedDevConsoleLogPath("/etc/desktop-dev-console.log")).toBe(
        false,
      );
      expect(
        isAllowedDevConsoleLogPath(join(tmpdir(), "desktop-dev-console.log")),
      ).toBe(false);
    });

    it("rejects a `..` traversal that escapes the state dir", () => {
      expect(
        isAllowedDevConsoleLogPath(
          join(stateDir, "..", "desktop-dev-console.log"),
        ),
      ).toBe(false);
    });

    it("rejects the state dir itself when that path's basename is the log name", () => {
      const logNamedState = realpathSync(
        mkdtempSync(join(tmpdir(), "desktop-dev-console.log-")),
      );
      const previous = process.env.ELIZA_STATE_DIR;
      const logAsStateDir = join(logNamedState, "desktop-dev-console.log");
      mkdirSync(logAsStateDir);
      try {
        process.env.ELIZA_STATE_DIR = logAsStateDir;
        expect(isAllowedDevConsoleLogPath(logAsStateDir)).toBe(false);
      } finally {
        if (previous === undefined) delete process.env.ELIZA_STATE_DIR;
        else process.env.ELIZA_STATE_DIR = previous;
        rmSync(logNamedState, { recursive: true, force: true });
      }
    });
  });

  describe("readDevConsoleLogTail", () => {
    const logPath = () => join(stateDir, "desktop-dev-console.log");

    afterAll(() => {
      rmSync(logPath(), { force: true });
    });

    it("returns log file not found when the path is missing", () => {
      expect(
        readDevConsoleLogTail(join(stateDir, "missing-console.log")),
      ).toEqual({ ok: false, error: "log file not found" });
    });

    it("returns not a file when the path is a directory", () => {
      const dirPath = join(stateDir, "not-a-file-console.log");
      mkdirSync(dirPath);
      try {
        expect(readDevConsoleLogTail(dirPath)).toEqual({
          ok: false,
          error: "not a file",
        });
      } finally {
        rmSync(dirPath, { recursive: true, force: true });
      }
    });

    it("returns a single trailing newline for an empty file", () => {
      writeFileSync(logPath(), "");
      expect(readDevConsoleLogTail(logPath())).toEqual({
        ok: true,
        body: "\n",
      });
    });

    it("returns a single-line file with a terminating newline", () => {
      writeFileSync(logPath(), "only-line");
      expect(readDevConsoleLogTail(logPath())).toEqual({
        ok: true,
        body: "only-line\n",
      });
    });

    it("does not duplicate an already-terminating newline on a single line", () => {
      writeFileSync(logPath(), "only-line\n");
      expect(readDevConsoleLogTail(logPath())).toEqual({
        ok: true,
        body: "only-line\n",
      });
    });

    it("preserves internal blank lines and strips trailing empty lines", () => {
      writeFileSync(logPath(), "a\n\nb\n\n\n");
      expect(readDevConsoleLogTail(logPath())).toEqual({
        ok: true,
        body: "a\n\nb\n",
      });
    });

    it("keeps CRLF line endings as part of each record and still ends with \\n", () => {
      writeFileSync(logPath(), "a\r\nb\r\n");
      expect(readDevConsoleLogTail(logPath())).toEqual({
        ok: true,
        body: "a\r\nb\r\n",
      });
    });

    it("returns the last maxLines lines when the file is longer than the cap", () => {
      const lines = Array.from({ length: 10 }, (_, i) => `line-${i}`);
      writeFileSync(logPath(), `${lines.join("\n")}\n`);
      expect(readDevConsoleLogTail(logPath(), { maxLines: 3 })).toEqual({
        ok: true,
        body: "line-7\nline-8\nline-9\n",
      });
    });

    it("clamps maxLines below 1 up to a single last line", () => {
      writeFileSync(logPath(), "one\ntwo\nthree\n");
      expect(readDevConsoleLogTail(logPath(), { maxLines: 0 })).toEqual({
        ok: true,
        body: "three\n",
      });
      expect(readDevConsoleLogTail(logPath(), { maxLines: -12 })).toEqual({
        ok: true,
        body: "three\n",
      });
    });

    it("defaults to 400 lines when maxLines is omitted", () => {
      const lines = Array.from({ length: 401 }, (_, i) => `L${i}`);
      writeFileSync(logPath(), `${lines.join("\n")}\n`);
      const result = readDevConsoleLogTail(logPath());
      expect(result.ok).toBe(true);
      if (result.ok !== true) return;
      const out = result.body.replace(/\n$/, "").split("\n");
      expect(out).toHaveLength(400);
      expect(out[0]).toBe("L1");
      expect(out[399]).toBe("L400");
    });

    it("caps maxLines at 5000 even when a larger value is requested", () => {
      const lines = Array.from({ length: 5001 }, (_, i) => String(i));
      writeFileSync(logPath(), `${lines.join("\n")}\n`);
      const result = readDevConsoleLogTail(logPath(), { maxLines: 10_000 });
      expect(result.ok).toBe(true);
      if (result.ok !== true) return;
      const out = result.body.replace(/\n$/, "").split("\n");
      expect(out).toHaveLength(5000);
      expect(out[0]).toBe("1");
      expect(out[4999]).toBe("5000");
    });

    it("reads only the last maxBytes window, which may start mid-line", () => {
      writeFileSync(logPath(), `${"A".repeat(3000)}\nTAIL-LINE\n`);
      const result = readDevConsoleLogTail(logPath(), {
        maxLines: 50,
        maxBytes: 1024,
      });
      expect(result.ok).toBe(true);
      if (result.ok !== true) return;
      expect(result.body.endsWith("TAIL-LINE\n")).toBe(true);
      expect(result.body.length).toBeLessThanOrEqual(1024 + 1);
      expect(result.body.startsWith("A")).toBe(true);
    });

    it("clamps maxBytes below 1024 up to 1024", () => {
      const payload = `${"B".repeat(2000)}\nEND\n`;
      writeFileSync(logPath(), payload);
      const unclamped = readDevConsoleLogTail(logPath(), { maxBytes: 1024 });
      const clampedLow = readDevConsoleLogTail(logPath(), { maxBytes: 1 });
      expect(unclamped).toEqual(clampedLow);
      expect(clampedLow.ok).toBe(true);
      if (clampedLow.ok !== true) return;
      expect(clampedLow.body.endsWith("END\n")).toBe(true);
    });

    it("caps maxBytes at 2_000_000 even when a larger value is requested", () => {
      const payload = Buffer.alloc(2_100_000, 0x61);
      payload.set(Buffer.from("\nEND\n"), payload.length - 5);
      writeFileSync(logPath(), payload);
      const result = readDevConsoleLogTail(logPath(), { maxBytes: 5_000_000 });
      expect(result.ok).toBe(true);
      if (result.ok !== true) return;
      expect(result.body.endsWith("END\n")).toBe(true);
      expect(result.body.length).toBe(2_000_000);
    });

    it("tails a path even when the basename would fail the allow-list", () => {
      const other = join(stateDir, "secrets.log");
      writeFileSync(other, "leaked\n");
      try {
        expect(isAllowedDevConsoleLogPath(other)).toBe(false);
        expect(readDevConsoleLogTail(other)).toEqual({
          ok: true,
          body: "leaked\n",
        });
      } finally {
        rmSync(other, { force: true });
      }
    });

    it("returns the filesystem error when the file cannot be opened", () => {
      writeFileSync(logPath(), "secret\n");
      chmodSync(logPath(), 0);
      try {
        const result = readDevConsoleLogTail(logPath());
        if (typeof process.getuid === "function" && process.getuid() === 0) {
          expect(result.ok).toBe(true);
          return;
        }
        expect(result.ok).toBe(false);
        if (result.ok !== false) return;
        expect(result.error.length).toBeGreaterThan(0);
        expect(result.error).toMatch(/EACCES|permission denied|not permitted/i);
      } finally {
        chmodSync(logPath(), 0o644);
      }
    });
  });
});
