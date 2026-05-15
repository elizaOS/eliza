import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeConfigEnvKeys } from "../services/config-env.js";
import {
  detectOrchestratorCapabilities,
  detectOrchestratorTerminalSupport,
  resolveExecutable,
  resolveOrchestratorShell,
} from "../services/terminal-capabilities.js";

const ENV_KEYS = [
  "ELIZA_PLATFORM",
  "ELIZA_AOSP_BUILD",
  "ELIZA_RUNTIME_MODE",
  "RUNTIME_MODE",
  "LOCAL_RUNTIME_MODE",
  "ELIZA_BUILD_VARIANT",
  "ELIZA_BUILD_VARIANT",
  "CODING_TOOLS_SHELL",
  "SHELL",
  "PATH",
  "ELIZA_STATE_DIR",
  "ELIZA_NAMESPACE",
  "ELIZAOS_ACP_COMMAND",
  "ELIZA_OPENCODE_ACP_COMMAND",
  "ELIZA_PI_AGENT_ACP_COMMAND",
] as const;

let savedEnv: Record<string, string | undefined>;
let tempDir = "";

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  tempDir = mkdtempSync(path.join(tmpdir(), "orch-cap-"));
  process.env.ELIZA_STATE_DIR = tempDir;
  process.env.ELIZA_NAMESPACE = "eliza";
  delete process.env.ELIZAOS_ACP_COMMAND;
  delete process.env.ELIZA_OPENCODE_ACP_COMMAND;
  delete process.env.ELIZA_PI_AGENT_ACP_COMMAND;
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

describe("orchestrator terminal capability detection", () => {
  it("uses the AOSP shell override when present", () => {
    const shell = executable("aosp-sh");
    process.env.ELIZA_PLATFORM = "android";
    process.env.CODING_TOOLS_SHELL = shell;
    process.env.SHELL = "/definitely/missing";
    process.env.PATH = tempDir;

    const resolved = resolveOrchestratorShell();

    expect(resolved.available).toBe(true);
    expect(resolved.command).toBe(shell);
    expect(resolved.source).toBe("env:CODING_TOOLS_SHELL");
  });

  it("detects Android PATH binaries without invoking which", () => {
    const acpx = executable("acpx");
    process.env.ELIZA_PLATFORM = "android";
    process.env.PATH = tempDir;

    expect(resolveExecutable("acpx")).toBe(acpx);
  });

  it("accepts direct Android local-yolo when a shell is executable", () => {
    const shell = executable("sh");
    process.env.ELIZA_PLATFORM = "android";
    process.env.ELIZA_RUNTIME_MODE = "local-yolo";
    process.env.CODING_TOOLS_SHELL = shell;
    process.env.PATH = tempDir;

    const support = detectOrchestratorTerminalSupport();

    expect(support.supported).toBe(true);
  });

  it("rejects Play/store Android even when local-yolo has a staged shell", () => {
    const shell = executable("sh");
    process.env.ELIZA_BUILD_VARIANT = "store";
    process.env.ELIZA_PLATFORM = "android";
    process.env.ELIZA_RUNTIME_MODE = "local-yolo";
    process.env.CODING_TOOLS_SHELL = shell;
    process.env.PATH = tempDir;

    const support = detectOrchestratorTerminalSupport();

    expect(support.supported).toBe(false);
    expect(support.reason).toBe("store_build");
  });

  it("rejects iOS terminal support", () => {
    process.env.ELIZA_PLATFORM = "ios";
    process.env.ELIZA_RUNTIME_MODE = "local-yolo";

    const support = detectOrchestratorTerminalSupport();

    expect(support.supported).toBe(false);
    expect(support.reason).toBe("vanilla_mobile");
    expect(support.message).toContain("iOS");
  });

  it("accepts branded AOSP local-yolo when a shell is executable", () => {
    const shell = executable("sh");
    process.env.ELIZA_PLATFORM = "android";
    process.env.ELIZA_AOSP_BUILD = "1";
    process.env.ELIZA_RUNTIME_MODE = "local-yolo";
    process.env.CODING_TOOLS_SHELL = shell;
    process.env.PATH = tempDir;

    const support = detectOrchestratorTerminalSupport();

    expect(support.supported).toBe(true);
  });

  it("reports configured adapter command overrides as available", () => {
    const elizaos = executable("elizaos-acp");
    const piAgent = executable("pi-agent-acp");
    writeConfigEnvKeys({
      ELIZAOS_ACP_COMMAND: `${elizaos} acp`,
      ELIZA_PI_AGENT_ACP_COMMAND: `${piAgent} acp`,
    });
    process.env.PATH = "";

    const capabilities = detectOrchestratorCapabilities();

    expect(capabilities.find((item) => item.name === "elizaos")).toMatchObject({
      available: true,
      path: `${elizaos} acp`,
    });
    expect(capabilities.find((item) => item.name === "pi-agent")).toMatchObject(
      {
        available: true,
        path: `${piAgent} acp`,
      },
    );
  });
});
