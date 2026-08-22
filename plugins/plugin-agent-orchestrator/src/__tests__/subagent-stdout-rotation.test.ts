/**
 * Non-destructive rotation contract of the durable per-session stdout log:
 * rotation renames the active file to the NEXT `.<n>` generation (never
 * overwriting an earlier one) and readSubagentStdout spans every generation
 * oldest-first, so chunk indices are stable global offsets and the canonical
 * transcript backing acpx-session-output references is never ablated. Real
 * filesystem via a temp trajectory dir; big generations are seeded directly
 * on disk (same NDJSON record shape) to keep the suite fast.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendSubagentStdout,
  readSubagentStdout,
  subagentStdoutLogPath,
} from "../services/subagent-stdout-log.js";

let dir: string;
let savedDir: string | undefined;
let savedLogging: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "stdout-log-"));
  savedDir = process.env.ELIZA_TRAJECTORY_DIR;
  savedLogging = process.env.ELIZA_TRAJECTORY_LOGGING;
  process.env.ELIZA_TRAJECTORY_DIR = dir;
  process.env.ELIZA_TRAJECTORY_LOGGING = "1";
});

afterEach(() => {
  if (savedDir === undefined) delete process.env.ELIZA_TRAJECTORY_DIR;
  else process.env.ELIZA_TRAJECTORY_DIR = savedDir;
  if (savedLogging === undefined) delete process.env.ELIZA_TRAJECTORY_LOGGING;
  else process.env.ELIZA_TRAJECTORY_LOGGING = savedLogging;
  fs.rmSync(dir, { recursive: true, force: true });
});

// One chunk large enough that the active file crosses the 10 MiB rotation
// threshold on its own.
const BIG = "x".repeat(10 * 1024 * 1024 + 512);

function seedRecord(logPath: string, text: string): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(
    logPath,
    `${JSON.stringify({ ts: new Date().toISOString(), text })}\n`,
    "utf8",
  );
}

describe("subagent stdout log rotation", () => {
  it("keeps every generation and spans them with stable global chunk indices", async () => {
    const sessionId = "rotate-1";
    const logPath = subagentStdoutLogPath(sessionId);
    seedRecord(logPath, BIG); // chunk 0 — active crosses the threshold
    await appendSubagentStdout(sessionId, "B"); // rotates → .1; chunk 1
    await appendSubagentStdout(sessionId, "C"); // chunk 2
    seedRecord(logPath, BIG); // chunk 3 — active crosses again
    await appendSubagentStdout(sessionId, "E"); // rotates → .2; chunk 4

    // Both generations survive — no overwrite.
    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
    expect(fs.existsSync(`${logPath}.2`)).toBe(true);
    expect(fs.existsSync(logPath)).toBe(true);

    const window = await readSubagentStdout(sessionId, {
      offset: 0,
      limit: 10,
    });
    expect(window?.totalChunks).toBe(5);
    expect(window?.rotated).toBe(true);
    expect(window?.hasMore).toBe(false);
    // Lossless reassembly across every generation plus the active file.
    expect(window?.text).toBe(`${BIG}BC${BIG}E`);

    // Global indexing: a mid-stream window crosses generation boundaries.
    const mid = await readSubagentStdout(sessionId, { offset: 1, limit: 2 });
    expect(mid?.text).toBe("BC");
    expect(mid?.offset).toBe(1);
    expect(mid?.hasMore).toBe(true);
  }, 60_000);

  it("echoes the effective limit so a clamped caller limit is reported, not silent", async () => {
    const sessionId = "clamp-1";
    for (let i = 0; i < 5; i++) {
      await appendSubagentStdout(sessionId, String(i));
    }
    const window = await readSubagentStdout(sessionId, { offset: 0, limit: 2 });
    expect(window).toMatchObject({
      offset: 0,
      limit: 2,
      totalChunks: 5,
      hasMore: true,
    });
    expect(window?.text).toBe("01");

    const clamped = await readSubagentStdout(sessionId, {
      offset: 0,
      limit: 50_000,
    });
    expect(clamped?.limit).toBe(10_000);
    expect(clamped?.hasMore).toBe(false);
  });

  it("keeps negative-offset tail semantics", async () => {
    const sessionId = "tail-1";
    for (const chunk of ["a", "b", "c", "d"]) {
      await appendSubagentStdout(sessionId, chunk);
    }
    const tail = await readSubagentStdout(sessionId, { limit: 2 });
    expect(tail?.text).toBe("cd");
    expect(tail?.offset).toBe(2);
    expect(tail?.hasMore).toBe(false);
    expect(tail?.rotated).toBe(false);
  });
});
