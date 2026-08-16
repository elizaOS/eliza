/**
 * Exercises the explicit host executable authority with deterministic,
 * process-local boot captures; no runtime configuration or plugin mocks are
 * involved.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyHostExecutionBaseline,
  captureHostExecutionBaseline,
  createHostExecutionBaseline,
  getHostExecutionBaseline,
  resolveHostExecutable,
  validateHostExecutionPath,
} from "./host-execution-env.ts";

describe("host execution boot baseline", () => {
  it("captures before a later PATH write in a fresh process", () => {
    const bootPath = process.env.PATH;
    expect(bootPath).toBeTruthy();
    const fixture = fileURLToPath(
      new URL("./host-execution-env.fixture.ts", import.meta.url),
    );
    const stdout = execFileSync(process.execPath, [fixture], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: bootPath,
        ELIZA_TEST_MUTATED_PATH: "/tmp/plugin-controlled-bin",
      },
    });
    expect(JSON.parse(stdout)).toEqual({ path: bootPath });
  });

  it("keeps a fresh process capture after later environment mutation", () => {
    const bootPath =
      path.delimiter === ";" ? "C:\\Windows\\System32" : "/usr/bin:/bin";
    process.env.PATH = bootPath;
    captureHostExecutionBaseline();
    process.env.PATH = "/tmp/plugin-bin";
    const later = captureHostExecutionBaseline();
    expect(later.path).toBe(bootPath);
    expect(getHostExecutionBaseline().path).toBe(bootPath);
  });

  it("fails closed for absent, relative, empty-entry, and NUL paths", () => {
    expect(validateHostExecutionPath(undefined)).toBeUndefined();
    expect(validateHostExecutionPath("relative/bin")).toBeUndefined();
    expect(validateHostExecutionPath(`/bin${path.delimiter}`)).toBeUndefined();
    expect(validateHostExecutionPath("/bin\0/tmp")).toBeUndefined();
  });

  it("accepts the Windows Path casing but rejects ambiguous case variants", () => {
    expect(
      createHostExecutionBaseline({ Path: "C:\\Windows\\System32" }, "win32")
        .path,
    ).toBe("C:\\Windows\\System32");
    expect(
      createHostExecutionBaseline(
        { PATH: "C:\\Windows", Path: "C:\\Tools" },
        "win32",
      ).path,
    ).toBeUndefined();
  });

  it("adds only PATH to an already-sanitized environment", () => {
    const bootPath = getHostExecutionBaseline().path;
    expect(
      applyHostExecutionBaseline({ Path: "/tmp/late", SAFE: "yes" }),
    ).toEqual({ PATH: bootPath, SAFE: "yes" });
  });

  it("rejects executable paths outside the captured PATH directories", () => {
    if (process.platform === "win32") return;
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "host-authority-"));
    const executable = path.join(tempDir, "outside-path");
    try {
      writeFileSync(executable, "#!/bin/sh\nexit 0\n");
      chmodSync(executable, 0o755);
      expect(resolveHostExecutable(executable)).toBeUndefined();
      expect(resolveHostExecutable("/bin/sh")).toBe("/bin/sh");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
