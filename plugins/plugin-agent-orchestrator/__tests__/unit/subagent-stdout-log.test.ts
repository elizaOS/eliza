/**
 * Unit tests for the append-only sub-agent stdout log (#13775 item 3). Real
 * filesystem writes to a temp trajectory dir — no mocks of the module under
 * test. Covers: gate (no write when recording is off), file survival after the
 * write, NDJSON line shape, and single-generation rotation past the byte cap.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendSubagentStdout,
  subagentStdoutLogPath,
} from "../../src/services/subagent-stdout-log.ts";

let tmpDir: string;
const priorTrajDir = process.env.ELIZA_TRAJECTORY_DIR;
const priorRecording = process.env.ELIZA_TRAJECTORY_RECORDING;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-stdout-test-"));
  process.env.ELIZA_TRAJECTORY_DIR = tmpDir;
  delete process.env.ELIZA_TRAJECTORY_RECORDING; // default ON
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  if (priorTrajDir === undefined) delete process.env.ELIZA_TRAJECTORY_DIR;
  else process.env.ELIZA_TRAJECTORY_DIR = priorTrajDir;
  if (priorRecording === undefined)
    delete process.env.ELIZA_TRAJECTORY_RECORDING;
  else process.env.ELIZA_TRAJECTORY_RECORDING = priorRecording;
});

describe("appendSubagentStdout", () => {
  it("writes an NDJSON record under the trajectory dir and returns the path", async () => {
    const returned = await appendSubagentStdout("ses_1", "hello from agent\n");
    const expected = subagentStdoutLogPath("ses_1");
    expect(returned).toBe(expected);
    expect(expected.startsWith(path.join(tmpDir, "subagent-stdout"))).toBe(
      true,
    );

    const raw = await fs.readFile(expected, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as { ts: string; text: string };
    expect(parsed.text).toBe("hello from agent\n");
    expect(typeof parsed.ts).toBe("string");
  });

  it("survives session close: the file persists after the write returns", async () => {
    await appendSubagentStdout("ses_survive", "chunk-a");
    await appendSubagentStdout("ses_survive", "chunk-b");
    // The file is not owned by any in-memory session map, so a later read (the
    // stand-in for post-close discovery) still finds both chunks.
    const raw = await fs.readFile(subagentStdoutLogPath("ses_survive"), "utf8");
    const texts = raw
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as { text: string }).text);
    expect(texts).toEqual(["chunk-a", "chunk-b"]);
  });

  it("no-ops (writes nothing, returns undefined) when recording is disabled", async () => {
    process.env.ELIZA_TRAJECTORY_RECORDING = "0";
    const returned = await appendSubagentStdout(
      "ses_off",
      "should not persist",
    );
    expect(returned).toBeUndefined();
    await expect(
      fs.readFile(subagentStdoutLogPath("ses_off"), "utf8"),
    ).rejects.toThrow();
  });

  it("rotates to a single .1 generation once the file crosses the byte cap", async () => {
    const logPath = subagentStdoutLogPath("ses_rotate");
    // Pre-seed the file past the 10 MiB cap so the next append triggers rotation.
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.writeFile(logPath, "x".repeat(10 * 1024 * 1024 + 1), "utf8");

    await appendSubagentStdout("ses_rotate", "post-rotation line");

    // The oversized content moved to `.1`; the live file holds only the new line.
    const rolled = await fs.readFile(`${logPath}.1`, "utf8");
    expect(rolled.length).toBeGreaterThan(10 * 1024 * 1024);
    const current = await fs.readFile(logPath, "utf8");
    const lines = current.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]) as { text: string }).text).toBe(
      "post-rotation line",
    );
    // Single generation only — no `.2` accumulates.
    await expect(fs.stat(`${logPath}.2`)).rejects.toThrow();
  });

  it("sanitizes session ids so the log stays inside the stdout dir", async () => {
    await appendSubagentStdout("../escape/attempt", "x");
    const dir = path.join(tmpDir, "subagent-stdout");
    const p = subagentStdoutLogPath("../escape/attempt");
    // Path separators are stripped, so the resolved file is a direct child of
    // the stdout dir — no traversal escapes the trajectory root.
    expect(path.dirname(path.resolve(p))).toBe(path.resolve(dir));
    expect(path.basename(p)).not.toContain("/");
    await expect(fs.readFile(p, "utf8")).resolves.toContain('"text":"x"');
  });
});
