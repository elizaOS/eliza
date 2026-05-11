import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectTerminalSupport,
  missingTerminalToolForCommand,
  resolveExecutable,
  resolveTerminalShell,
} from "../utils/terminalCapabilities";

const ENV_KEYS = [
  "ELIZA_PLATFORM",
  "ELIZA_AOSP_BUILD",
  "ELIZA_RUNTIME_MODE",
  "RUNTIME_MODE",
  "LOCAL_RUNTIME_MODE",
  "MILADY_BUILD_VARIANT",
  "ELIZA_BUILD_VARIANT",
  "CODING_TOOLS_SHELL",
  "SHELL",
  "PATH",
] as const;

let savedEnv: Record<string, string | undefined>;
let tempDir = "";

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  tempDir = mkdtempSync(path.join(tmpdir(), "shell-cap-"));
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

function executable(name: string): string {
  const file = path.join(tempDir, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  return file;
}

describe("shell terminal capability detection", () => {
  it("uses the Android service shell override when present", () => {
    const shell = executable("aosp-sh");
    process.env.ELIZA_PLATFORM = "android";
    process.env.CODING_TOOLS_SHELL = shell;
    process.env.SHELL = "/definitely/missing";
    process.env.PATH = tempDir;

    const resolved = resolveTerminalShell();

    expect(resolved.available).toBe(true);
    expect(resolved.shell).toBe(shell);
    expect(resolved.source).toBe("env:CODING_TOOLS_SHELL");
  });

  it("detects missing known tools before spawning", () => {
    const git = executable("git");
    process.env.ELIZA_PLATFORM = "android";
    process.env.PATH = tempDir;

    expect(resolveExecutable("git")).toBe(git);
    expect(missingTerminalToolForCommand("git status")).toBeUndefined();
    expect(missingTerminalToolForCommand("acpx codex prompt hi")).toBe("acpx");
  });

  it("rejects vanilla Android terminal support", () => {
    process.env.ELIZA_PLATFORM = "android";
    process.env.ELIZA_RUNTIME_MODE = "local-yolo";
    process.env.PATH = tempDir;

    const support = detectTerminalSupport();

    expect(support.supported).toBe(false);
    expect(support.reason).toBe("vanilla_mobile");
    expect(support.message).toContain("branded AOSP");
  });

  it("accepts branded AOSP local-yolo when a shell is executable", () => {
    const shell = executable("sh");
    process.env.ELIZA_PLATFORM = "android";
    process.env.ELIZA_AOSP_BUILD = "1";
    process.env.ELIZA_RUNTIME_MODE = "local-yolo";
    process.env.CODING_TOOLS_SHELL = shell;
    process.env.PATH = tempDir;

    const support = detectTerminalSupport();

    expect(support.supported).toBe(true);
  });
});
