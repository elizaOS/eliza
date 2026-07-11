/**
 * Branch coverage for the MP4 assembly helper. ffmpeg + the filesystem are kept
 * at the boundary: `node:child_process` spawnSync and `node:fs` are faked so the
 * card-render / concat / mux / cleanup branches run deterministically without a
 * real ffmpeg binary or disk writes. The mocks are restored in afterAll so the
 * sibling harness suite (which exercises the REAL ensureFfmpeg) is not poisoned
 * in the non-isolated coverage lane.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import * as realChildProcess from "node:child_process";
import * as realFs from "node:fs";

const realChildProcessExports = { ...realChildProcess };
const realFsExports = { ...realFs };

interface SpawnCall {
  cmd: string;
  args: string[];
}
const spawnCalls: SpawnCall[] = [];
// Per-invocation status queue: shift a status for each spawnSync call so a test
// can make an individual ffmpeg step (card/concat/mux) fail.
let spawnStatuses: number[] = [];
let spawnDefaultStatus = 0;
let ffmpegVersionStdout = "ffmpeg version 6.0\n";

mock.module("node:child_process", () => ({
  ...realChildProcessExports,
  spawnSync: (cmd: string, args: string[]) => {
    spawnCalls.push({ cmd, args });
    // The `-version` probe is special: return version stdout.
    if (args?.[0] === "-version") {
      return { status: 0, stdout: ffmpegVersionStdout, stderr: "" };
    }
    const status =
      spawnStatuses.length > 0 ? spawnStatuses.shift() : spawnDefaultStatus;
    return { status, stdout: "", stderr: "ffmpeg-stderr-detail" };
  },
}));

const existingPaths = new Set<string>();
const removed: string[] = [];

mock.module("node:fs", () => ({
  ...realFsExports,
  existsSync: (p: string) => existingPaths.has(p),
  rmSync: (p: string) => {
    removed.push(p);
  },
}));

// Bun.write is used to stage the concat list + fallback audio; make it a no-op
// spy so no disk I/O happens.
const writes: unknown[] = [];
const originalBunWrite = Bun.write;
(Bun as unknown as { write: unknown }).write = ((target: unknown) => {
  writes.push(target);
  return Promise.resolve(0);
}) as typeof Bun.write;

const { ensureFfmpeg, assembleMp4 } = await import("./mp4");

const DIR = "/evidence";
const IN = "input.wav";
const OUT_AUDIO = "output.wav";
const inPath = `${DIR}/${IN}`;
const outAudioPath = `${DIR}/${OUT_AUDIO}`;

beforeEach(() => {
  spawnCalls.length = 0;
  spawnStatuses = [];
  spawnDefaultStatus = 0;
  ffmpegVersionStdout = "ffmpeg version 6.0\n";
  existingPaths.clear();
  removed.length = 0;
  writes.length = 0;
  // The input WAV + the intermediates exist by default.
  existingPaths.add(inPath);
  existingPaths.add(outAudioPath);
  existingPaths.add(`${DIR}/timeline-card.png`);
  existingPaths.add(`${DIR}/combined-audio.wav`);
  existingPaths.add(`${DIR}/concat-list.txt`);
});

afterAll(() => {
  mock.module("node:child_process", () => realChildProcessExports);
  mock.module("node:fs", () => realFsExports);
  (Bun as unknown as { write: unknown }).write = originalBunWrite;
});

function run() {
  return assembleMp4({
    dir: DIR,
    inputWav: IN,
    outputWav: OUT_AUDIO,
    timelineLines: ["t=0 hello", "path: a:b\\c", "quote's here"],
    out: "walkthrough.mp4",
  });
}

describe("ensureFfmpeg", () => {
  test("reports ok + version when the ffmpeg probe succeeds", () => {
    const r = ensureFfmpeg();
    expect(r.ok).toBe(true);
    expect(r.version).toContain("ffmpeg version");
    expect(r.installHint).toContain("ffmpeg is required");
  });

  test("reports not-ok with the install hint when the probe fails", () => {
    ffmpegVersionStdout = "";
    const r = ensureFfmpeg();
    expect(r.ok).toBe(false);
    expect(r.installHint).toContain("apt-get install");
  });
});

describe("assembleMp4", () => {
  test("happy path: renders card, concats audio, muxes mp4, cleans intermediates", () => {
    const result = run();
    expect(result).toEqual({ ok: true });
    // card + concat + mux (+ the version probe) all ran.
    const nonProbe = spawnCalls.filter((c) => c.args[0] !== "-version");
    expect(nonProbe.length).toBe(3);
    // Escaping: colons/backslashes escaped, single quotes stripped in drawtext.
    const cardCall = nonProbe[0];
    const drawArg = cardCall.args.find((a) => a.startsWith("drawtext="));
    expect(drawArg).toBeDefined();
    expect(drawArg).not.toContain("quote's");
    // Intermediates removed.
    expect(removed).toEqual(
      expect.arrayContaining([
        `${DIR}/timeline-card.png`,
        `${DIR}/combined-audio.wav`,
        `${DIR}/concat-list.txt`,
      ]),
    );
  });

  test("returns the install hint when ffmpeg is unavailable", () => {
    ffmpegVersionStdout = "";
    const result = run();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ffmpeg is required");
  });

  test("fails loudly when the input WAV is missing", () => {
    existingPaths.delete(inPath);
    const result = run();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("missing input wav");
  });

  test("surfaces a card-render failure", () => {
    // probe ok (handled), then card render fails.
    spawnStatuses = [1];
    const result = run();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("card render failed");
  });

  test("falls back to input-only audio when the concat step fails", () => {
    // card ok, concat fails, mux ok.
    spawnStatuses = [0, 1, 0];
    const result = run();
    expect(result).toEqual({ ok: true });
    // The concat fallback wrote the input audio into combined-audio.wav.
    expect(writes.length).toBeGreaterThan(0);
  });

  test("uses the input as the second concat entry when the output WAV is absent", () => {
    existingPaths.delete(outAudioPath);
    const result = run();
    expect(result).toEqual({ ok: true });
  });

  test("surfaces a mux failure", () => {
    // card ok, concat ok, mux fails.
    spawnStatuses = [0, 0, 1];
    const result = run();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("mux failed");
  });

  test("cleanup is best-effort: an rmSync throw does not fail the assembly", () => {
    // Make rmSync throw so the best-effort cleanup catch runs.
    mock.module("node:fs", () => ({
      ...realFsExports,
      existsSync: (p: string) => existingPaths.has(p),
      rmSync: () => {
        throw new Error("EBUSY");
      },
    }));
    const result = run();
    expect(result).toEqual({ ok: true });
    // Restore the counting rmSync for subsequent tests in this file.
    mock.module("node:fs", () => ({
      ...realFsExports,
      existsSync: (p: string) => existingPaths.has(p),
      rmSync: (p: string) => {
        removed.push(p);
      },
    }));
  });
});
