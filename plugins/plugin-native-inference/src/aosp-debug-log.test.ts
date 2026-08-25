/**
 * Unit tests for `aosp-debug-log`: verifies environment-gated log destination
 * resolution, bigint-safe JSON serialization, append formatting, and error
 * suppression for diagnostic logging.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeAospLlamaDebugLog } from "./aosp-debug-log.ts";

describe("aosp-debug-log", () => {
  let testDir: string;
  const originalDebugEnv = process.env.ELIZA_AOSP_LLAMA_DEBUG_LOG;
  const originalStateEnv = process.env.ELIZA_STATE_DIR;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `eliza-aosp-debug-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    delete process.env.ELIZA_AOSP_LLAMA_DEBUG_LOG;
    delete process.env.ELIZA_STATE_DIR;
  });

  afterEach(() => {
    if (originalDebugEnv !== undefined) {
      process.env.ELIZA_AOSP_LLAMA_DEBUG_LOG = originalDebugEnv;
    } else {
      delete process.env.ELIZA_AOSP_LLAMA_DEBUG_LOG;
    }
    if (originalStateEnv !== undefined) {
      process.env.ELIZA_STATE_DIR = originalStateEnv;
    } else {
      delete process.env.ELIZA_STATE_DIR;
    }
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Teardown
    }
  });

  it.each([undefined, "", "0", "false", "FALSE", "   0   "])(
    "does not write when ELIZA_AOSP_LLAMA_DEBUG_LOG is disabled: %s",
    (val) => {
      if (val !== undefined) {
        process.env.ELIZA_AOSP_LLAMA_DEBUG_LOG = val;
      }
      process.env.ELIZA_STATE_DIR = testDir;

      writeAospLlamaDebugLog("model_init", { model: "eliza-1" });

      const expectedPath = join(testDir, "aosp-llama-debug.log");
      expect(existsSync(expectedPath)).toBe(false);
    },
  );

  it("skips writing when set to 1/true but ELIZA_STATE_DIR is empty", () => {
    process.env.ELIZA_AOSP_LLAMA_DEBUG_LOG = "1";
    delete process.env.ELIZA_STATE_DIR;

    expect(() => {
      writeAospLlamaDebugLog("test_event");
    }).not.toThrow();
  });

  it.each(["1", "true", "TRUE"])(
    "writes to state directory when ELIZA_AOSP_LLAMA_DEBUG_LOG is %s",
    (flag) => {
      process.env.ELIZA_AOSP_LLAMA_DEBUG_LOG = flag;
      process.env.ELIZA_STATE_DIR = testDir;

      writeAospLlamaDebugLog("fused_engine_ready", { layers: 32 });

      const logFile = join(testDir, "aosp-llama-debug.log");
      expect(existsSync(logFile)).toBe(true);

      const content = readFileSync(logFile, "utf8");
      expect(content).toContain("fused_engine_ready");
      expect(content).toContain('{"layers":32}');
      expect(content.endsWith("\n")).toBe(true);
    },
  );

  it("writes to explicit custom log path and creates nested directories", () => {
    const customLogFile = join(testDir, "nested", "custom-aosp.log");
    process.env.ELIZA_AOSP_LLAMA_DEBUG_LOG = customLogFile;

    writeAospLlamaDebugLog("stream_started");

    expect(existsSync(customLogFile)).toBe(true);
    const content = readFileSync(customLogFile, "utf8");
    expect(content).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z stream_started\n$/,
    );
  });

  it("safely serializes bigint values in details without throwing TypeError", () => {
    const logFile = join(testDir, "bigint-test.log");
    process.env.ELIZA_AOSP_LLAMA_DEBUG_LOG = logFile;

    expect(() => {
      writeAospLlamaDebugLog("token_counter", {
        totalTokens: 12345678901234567890n,
        step: 42n,
        label: "inference",
      });
    }).not.toThrow();

    const content = readFileSync(logFile, "utf8");
    expect(content).toContain(
      '{"totalTokens":"12345678901234567890","step":"42","label":"inference"}',
    );
  });

  it("appends multiple sequential log entries in order", () => {
    const logFile = join(testDir, "append.log");
    process.env.ELIZA_AOSP_LLAMA_DEBUG_LOG = logFile;

    writeAospLlamaDebugLog("event_1", { idx: 1 });
    writeAospLlamaDebugLog("event_2", { idx: 2 });

    const lines = readFileSync(logFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("event_1");
    expect(lines[1]).toContain("event_2");
  });

  it("swallows filesystem errors silently so diagnostics never throw", () => {
    // Use invalid path that cannot be created as a directory
    const logFile = join(testDir, "file_as_dir", "test.log");
    // Create a normal file where a directory is needed
    mkdirSync(testDir, { recursive: true });
    // Write a file at file_as_dir so mkdirSync with recursive will fail on conflict
    const blocker = join(testDir, "file_as_dir");
    readFileSync; // reference
    require("node:fs").writeFileSync(blocker, "regular file");

    process.env.ELIZA_AOSP_LLAMA_DEBUG_LOG = logFile;

    expect(() => {
      writeAospLlamaDebugLog("should_fail_silently");
    }).not.toThrow();
  });
});
