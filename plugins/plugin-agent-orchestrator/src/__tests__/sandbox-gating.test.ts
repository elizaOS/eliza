/**
 * Asserts the orchestrator's store-build gating: when MILADY_BUILD_VARIANT=store,
 * the plugin must register zero spawn-bearing services and a single TASKS stub
 * action whose handler returns a structured "blocked" result without ever
 * touching PTY / ACP / workspace state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Re-importing @elizaos/core via vi.resetModules() pays a one-time cold start
// that comfortably exceeds vitest's 5s default. Bump per-test timeouts to 30s
// so cold cache resolution does not flake CI.
const SLOW = 30_000;

describe("agent-orchestrator sandbox gating", () => {
  let originalVariant: string | undefined;

  beforeEach(() => {
    originalVariant = process.env.MILADY_BUILD_VARIANT;
  });

  afterEach(async () => {
    if (originalVariant === undefined) {
      delete process.env.MILADY_BUILD_VARIANT;
    } else {
      process.env.MILADY_BUILD_VARIANT = originalVariant;
    }
    vi.resetModules();
    const core = await import("@elizaos/core");
    core._resetBuildVariantForTests();
  });

  it("flags isLocalCodeExecutionAllowed=false under store variant", {
    timeout: SLOW,
  }, async () => {
    process.env.MILADY_BUILD_VARIANT = "store";
    vi.resetModules();
    const core = await import("@elizaos/core");
    core._resetBuildVariantForTests();
    expect(core.getBuildVariant()).toBe("store");
    expect(core.isLocalCodeExecutionAllowed()).toBe(false);
  });

  it("flags isLocalCodeExecutionAllowed=true under direct variant", {
    timeout: SLOW,
  }, async () => {
    process.env.MILADY_BUILD_VARIANT = "direct";
    vi.resetModules();
    const core = await import("@elizaos/core");
    core._resetBuildVariantForTests();
    expect(core.getBuildVariant()).toBe("direct");
    expect(core.isLocalCodeExecutionAllowed()).toBe(true);
  });

  it("registers no spawn services and only a TASKS stub under store builds", {
    timeout: SLOW,
  }, async () => {
    process.env.MILADY_BUILD_VARIANT = "store";
    vi.resetModules();
    const core = await import("@elizaos/core");
    core._resetBuildVariantForTests();

    const { agentOrchestratorPlugin } = await import("../index.js");
    expect(agentOrchestratorPlugin.services ?? []).toHaveLength(0);
    expect(agentOrchestratorPlugin.providers ?? []).toHaveLength(0);
    const actions = agentOrchestratorPlugin.actions ?? [];
    expect(actions).toHaveLength(1);
    expect(actions[0]?.name).toBe("TASKS");
  });

  it("returns a structured STORE_BUILD_BLOCKED result from the stub handler", {
    timeout: SLOW,
  }, async () => {
    process.env.MILADY_BUILD_VARIANT = "store";
    vi.resetModules();
    const core = await import("@elizaos/core");
    core._resetBuildVariantForTests();
    const { tasksSandboxStubAction } = await import(
      "../actions/sandbox-stub.js"
    );
    const result = await tasksSandboxStubAction.handler(
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
    );
    expect(result).toBeDefined();
    expect(result?.success).toBe(false);
    const data = result?.data as { reason?: string } | undefined;
    expect(data?.reason).toBe("STORE_BUILD_BLOCKED");
  });
});
