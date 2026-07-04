/**
 * Verifies detectOrchestratorCapabilities.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import {
  detectOrchestratorCapabilities,
  detectOrchestratorTerminalSupport,
  formatOrchestratorCapabilities,
  missingToolMessage,
  ORCHESTRATOR_TOOL_NAMES,
  type OrchestratorToolCapability,
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
