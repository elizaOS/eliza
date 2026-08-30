/**
 * Verifies orchestrator terminal capability detection: the structural
 * capability/formatting contract and the environment-gated support verdicts,
 * exercised against a real temp filesystem (consolidating the former
 * src/__tests__/terminal-capabilities.test.ts). Deterministic; no runtime,
 * no live model.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectOrchestratorCapabilities,
  detectOrchestratorTerminalSupport,
  formatOrchestratorCapabilities,
  missingToolMessage,
  ORCHESTRATOR_TOOL_NAMES,
  type OrchestratorToolCapability,
  resolveExecutable,
  resolveOrchestratorShell,
} from "../../src/services/terminal-capabilities.js";

// #9146 — terminal-capabilities is the file the issue cites for the iOS/Android/
// store gating. Pin the structural + formatting contract (host-independent) and
// the reason-code invariant on the support gate.
describe("detectOrchestratorCapabilities", () => {
  it("reports exactly one capability per known tool", () => {
    const caps = detectOrchestratorCapabilities();
    expect(caps.map((c) => c.name)).toEqual([...ORCHESTRATOR_TOOL_NAMES]);
    for (const c of caps) {
      expect(typeof c.available).toBe("boolean");
      if (c.available) expect(typeof c.path).toBe("string");
    }
  });
});

describe("formatOrchestratorCapabilities", () => {
  it("renders ok(path) / missing per tool", () => {
    const caps = [
      { name: "git", path: "/usr/bin/git", available: true },
      { name: "codex", available: false },
    ] as unknown as OrchestratorToolCapability[];
    expect(formatOrchestratorCapabilities(caps)).toBe(
      "git=ok(/usr/bin/git) codex=missing",
    );
  });
});

describe("missingToolMessage", () => {
  it("names the tool and points at PATH", () => {
    const msg = missingToolMessage("claude");
    expect(msg).toContain("claude");
    expect(msg).toContain("not available in PATH");
  });
});

describe("detectOrchestratorTerminalSupport", () => {
  it("returns a typed support verdict; any unsupported result carries a known reason", () => {
    const support = detectOrchestratorTerminalSupport();
    expect(typeof support.supported).toBe("boolean");
    if (!support.supported) {
      expect([
        "store_build",
        "vanilla_mobile",
        "not_local_yolo",
        "missing_shell",
      ]).toContain(support.reason);
      expect(typeof support.message).toBe("string");
    }
  });
});

const ENV_KEYS = [
  "ELIZA_PLATFORM",
  "ELIZA_AOSP_BUILD",
  "ELIZA_RUNTIME_MODE",
  "RUNTIME_MODE",
  "LOCAL_RUNTIME_MODE",
  "ELIZA_BUILD_VARIANT",
  "ELIZA_AOSP_BUILD_VARIANT",
  "CODING_TOOLS_SHELL",
  "SHELL",
  "PATH",
] as const;

let savedEnv: Record<string, string | undefined>;
let tempDir = "";

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  tempDir = mkdtempSync(path.join(tmpdir(), "orch-cap-"));
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

describe("orchestrator terminal capability detection (real temp filesystem)", () => {
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

    expect(detectOrchestratorTerminalSupport().supported).toBe(true);
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

    expect(detectOrchestratorTerminalSupport().supported).toBe(true);
  });
});
