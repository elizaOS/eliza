/**
 * Verifies orchestrator device support matrix (#9146).
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import {
  buildOrchestratorDeviceSupportMatrix,
  ORCHESTRATOR_BACKEND_AUTH,
  ORCHESTRATOR_BACKENDS,
  ORCHESTRATOR_DEVICE_SUPPORT_MATRIX,
} from "../services/orchestrator-device-support-matrix.js";
import { classifyTerminalSupport } from "../services/terminal-capabilities.js";

function row(id: string) {
  const r = ORCHESTRATOR_DEVICE_SUPPORT_MATRIX.find((x) => x.id === id);
  if (!r) throw new Error(`missing matrix row ${id}`);
  return r;
}

describe("orchestrator device support matrix (#9146)", () => {
  it("desktop supports every backend", () => {
    const r = row("desktop");
    expect(r.support.supported).toBe(true);
    expect(r.support.reason).toBeUndefined();
    expect(r.backends).toEqual(ORCHESTRATOR_BACKENDS);
  });

  it("iOS is unsupported with reason vanilla_mobile and no backends", () => {
    const r = row("ios");
    expect(r.support.supported).toBe(false);
    expect(r.support.reason).toBe("vanilla_mobile");
    expect(r.support.message).toContain("iOS");
    expect(r.backends).toEqual([]);
  });

  it("store build is unsupported with reason store_build", () => {
    const r = row("store");
    expect(r.support.supported).toBe(false);
    expect(r.support.reason).toBe("store_build");
    expect(r.backends).toEqual([]);
  });

  it("Android is unsupported when the image has no ACP runtime", () => {
    const r = row("android-store");
    expect(r.support.supported).toBe(false);
    expect(r.support.reason).toBe("missing_acp_runtime");
    expect(r.backends).toEqual([]);
  });

  it("Android local-yolo does not mistake a staged shell for an ACP runtime", () => {
    const r = row("android-local-yolo");
    expect(r.support.supported).toBe(false);
    expect(r.support.reason).toBe("missing_acp_runtime");
    expect(r.backends).toEqual([]);
  });

  it("store build takes precedence over android local-yolo (mirrors gate ordering)", () => {
    const support = classifyTerminalSupport({
      platform: "android",
      buildVariant: "store",
    });
    expect(support.supported).toBe(false);
    expect(support.reason).toBe("store_build");
  });

  it("Android without a shell still reports the deeper missing ACP runtime", () => {
    const support = classifyTerminalSupport({ platform: "android" });
    expect(support.supported).toBe(false);
    expect(support.reason).toBe("missing_acp_runtime");
  });

  it("classifier is pure — does not read or mutate process.env", () => {
    const before = process.env.ELIZA_PLATFORM;
    classifyTerminalSupport({ platform: "ios" });
    expect(process.env.ELIZA_PLATFORM).toBe(before);
  });

  it("every backend has at least one declared auth mode", () => {
    for (const backend of ORCHESTRATOR_BACKENDS) {
      expect(ORCHESTRATOR_BACKEND_AUTH[backend].length).toBeGreaterThan(0);
    }
  });

  it("claude prefers subscription before API auth (and codex prefers codex)", () => {
    expect(ORCHESTRATOR_BACKEND_AUTH.claude[0]).toBe("anthropic-subscription");
    expect(ORCHESTRATOR_BACKEND_AUTH.codex[0]).toBe("openai-codex");
  });

  it("buildOrchestratorDeviceSupportMatrix matches the eager snapshot", () => {
    expect(buildOrchestratorDeviceSupportMatrix()).toEqual(
      ORCHESTRATOR_DEVICE_SUPPORT_MATRIX,
    );
  });
});
