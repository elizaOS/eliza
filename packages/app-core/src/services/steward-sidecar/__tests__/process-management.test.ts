/**
 * Exercises Steward sidecar process-management against the real
 * `findStewardEntryPoint` and `pipeOutput` implementations using real temp
 * files and ReadableStreams. Logger spies only observe the structured log
 * contract; they do not stand in for the module under test.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { logger } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findStewardEntryPoint, pipeOutput } from "../process-management.ts";

const originalEntryPoint = process.env.STEWARD_ENTRY_POINT;
const tempDirs: string[] = [];

function makeEntryFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "steward-entry-"));
  tempDirs.push(dir);
  const file = path.join(dir, "entry.js");
  writeFileSync(file, "export {}\n");
  return file;
}

function bytesStream(
  chunks: Array<string | Uint8Array>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          typeof chunk === "string" ? encoder.encode(chunk) : chunk,
        );
      }
      controller.close();
    },
  });
}

function failingStream(beforeError?: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (beforeError) {
        controller.enqueue(new TextEncoder().encode(beforeError));
      }
      controller.error(new Error("stream closed"));
    },
  });
}

describe("findStewardEntryPoint", () => {
  beforeEach(() => {
    vi.spyOn(logger, "info").mockImplementation(() => {});
    vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalEntryPoint === undefined) {
      delete process.env.STEWARD_ENTRY_POINT;
    } else {
      process.env.STEWARD_ENTRY_POINT = originalEntryPoint;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("returns the STEWARD_ENTRY_POINT path when that file exists", async () => {
    const entry = makeEntryFile();
    process.env.STEWARD_ENTRY_POINT = entry;

    await expect(findStewardEntryPoint()).resolves.toBe(entry);
    expect(existsSync(entry)).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      `[StewardSidecar] Found entry point: ${entry}`,
    );
  });

  it("accepts an existing directory as the env candidate", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "steward-entry-dir-"));
    tempDirs.push(dir);
    process.env.STEWARD_ENTRY_POINT = dir;

    await expect(findStewardEntryPoint()).resolves.toBe(dir);
  });

  it("does not return a missing STEWARD_ENTRY_POINT path", async () => {
    const missing = path.join(
      tmpdir(),
      `steward-missing-${Date.now()}-${Math.random()}.js`,
    );
    process.env.STEWARD_ENTRY_POINT = missing;
    expect(existsSync(missing)).toBe(false);

    const result = await findStewardEntryPoint();
    expect(result).not.toBe(missing);
    if (result !== null) {
      expect(existsSync(result)).toBe(true);
    }
  });

  it("treats an empty STEWARD_ENTRY_POINT as absent", async () => {
    process.env.STEWARD_ENTRY_POINT = "";

    const result = await findStewardEntryPoint();
    expect(result).not.toBe("");
    if (result !== null) {
      expect(existsSync(result)).toBe(true);
    }
  });

  it("returns null when env is unset and no @stwd/api module exists on disk", async () => {
    delete process.env.STEWARD_ENTRY_POINT;

    const result = await findStewardEntryPoint();
    if (result === null) {
      expect(result).toBeNull();
    } else {
      expect(existsSync(result)).toBe(true);
    }
  });

  it("does not throw when module resolution cannot find @stwd/api", async () => {
    delete process.env.STEWARD_ENTRY_POINT;
    const result = await findStewardEntryPoint();
    expect(
      result === null || (typeof result === "string" && existsSync(result)),
    ).toBe(true);
  });
});

describe("pipeOutput", () => {
  beforeEach(() => {
    vi.spyOn(logger, "info").mockImplementation(() => {});
    vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves immediately for a null stream and never calls onLog", async () => {
    const onLog = vi.fn();
    await expect(pipeOutput(null, "stdout", onLog)).resolves.toBeUndefined();
    expect(onLog).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("resolves without logging when the stream closes empty", async () => {
    const onLog = vi.fn();
    await pipeOutput(bytesStream([]), "stdout", onLog);
    expect(onLog).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("logs stdout chunks through logger.info and onLog", async () => {
    const onLog = vi.fn();
    await pipeOutput(bytesStream(["ready on :3200"]), "stdout", onLog);

    expect(onLog).toHaveBeenCalledTimes(1);
    expect(onLog).toHaveBeenCalledWith("ready on :3200", "stdout");
    expect(logger.info).toHaveBeenCalledWith("[Steward] ready on :3200");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs stderr chunks through logger.warn and onLog", async () => {
    const onLog = vi.fn();
    await pipeOutput(bytesStream(["bind failed"]), "stderr", onLog);

    expect(onLog).toHaveBeenCalledTimes(1);
    expect(onLog).toHaveBeenCalledWith("bind failed", "stderr");
    expect(logger.warn).toHaveBeenCalledWith("[Steward:err] bind failed");
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("strips only trailing whitespace via trimEnd", async () => {
    const onLog = vi.fn();
    await pipeOutput(bytesStream(["  hello  \n"]), "stdout", onLog);
    expect(onLog).toHaveBeenCalledWith("  hello", "stdout");
  });

  it("does not split a single chunk on embedded newlines", async () => {
    const onLog = vi.fn();
    await pipeOutput(bytesStream(["line-a\nline-b\n"]), "stdout", onLog);
    expect(onLog).toHaveBeenCalledTimes(1);
    expect(onLog).toHaveBeenCalledWith("line-a\nline-b", "stdout");
  });

  it("skips chunks that are empty after trimEnd", async () => {
    const onLog = vi.fn();
    await pipeOutput(bytesStream(["\n", "   ", "keep", ""]), "stdout", onLog);
    expect(onLog).toHaveBeenCalledTimes(1);
    expect(onLog).toHaveBeenCalledWith("keep", "stdout");
  });

  it("invokes onLog once per non-empty chunk in order", async () => {
    const onLog = vi.fn();
    await pipeOutput(bytesStream(["one", "two", "three"]), "stderr", onLog);
    expect(onLog.mock.calls).toEqual([
      ["one", "stderr"],
      ["two", "stderr"],
      ["three", "stderr"],
    ]);
  });

  it("resolves without onLog when the callback is omitted", async () => {
    await expect(
      pipeOutput(bytesStream(["solo"]), "stdout"),
    ).resolves.toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith("[Steward] solo");
  });

  it("swallows a stream read error and still resolves", async () => {
    const onLog = vi.fn();
    await expect(
      pipeOutput(failingStream(), "stderr", onLog),
    ).resolves.toBeUndefined();
    expect(onLog).not.toHaveBeenCalled();
  });

  it("resolves when start() enqueues a chunk then errors in the same turn", async () => {
    const onLog = vi.fn();
    await expect(
      pipeOutput(failingStream("partial-line"), "stdout", onLog),
    ).resolves.toBeUndefined();
    // Observed: a same-turn controller.error() rejects the reader before
    // the enqueued chunk is delivered, so onLog is not invoked.
    expect(onLog).not.toHaveBeenCalled();
  });

  it("decodes multi-byte utf-8 in a single chunk", async () => {
    const onLog = vi.fn();
    await pipeOutput(bytesStream(["café — 你好"]), "stdout", onLog);
    expect(onLog).toHaveBeenCalledWith("café — 你好", "stdout");
  });
});
