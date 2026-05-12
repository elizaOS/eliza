/**
 * Asserts the orchestrator's store-build gating: when ELIZA_BUILD_VARIANT=store,
 * the plugin must register zero spawn-bearing services and a single TASKS stub
 * action whose handler returns a structured "blocked" result without ever
 * touching PTY / ACP / workspace state.
 */

import {
  _resetBuildVariantForTests,
  getBuildVariant,
  isLocalCodeExecutionAllowed,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tasksSandboxStubAction } from "../actions/sandbox-stub.js";
import { createAgentOrchestratorPlugin } from "../index.js";

// Keep the slow timeout because importing @elizaos/core from this plugin can
// still exceed Vitest's default timeout on a cold cache.
const SLOW = 30_000;

describe("agent-orchestrator sandbox gating", () => {
  const ENV_KEYS = [
    "ELIZA_BUILD_VARIANT",
    "ELIZA_BUILD_VARIANT",
    "ELIZA_PLATFORM",
    "ELIZA_AOSP_BUILD",
    "ELIZA_RUNTIME_MODE",
    "RUNTIME_MODE",
    "LOCAL_RUNTIME_MODE",
    "CODING_TOOLS_SHELL",
    "SHELL",
    "PATH",
  ] as const;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = Object.fromEntries(
      ENV_KEYS.map((key) => [key, process.env[key]]),
    );
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetBuildVariantForTests();
  });

  it("flags isLocalCodeExecutionAllowed=false under store variant", {
    timeout: SLOW,
  }, async () => {
    process.env.ELIZA_BUILD_VARIANT = "store";
    _resetBuildVariantForTests();
    expect(getBuildVariant()).toBe("store");
    expect(isLocalCodeExecutionAllowed()).toBe(false);
  });

  it("flags isLocalCodeExecutionAllowed=true under direct variant", {
    timeout: SLOW,
  }, async () => {
    process.env.ELIZA_BUILD_VARIANT = "direct";
    _resetBuildVariantForTests();
    expect(getBuildVariant()).toBe("direct");
    expect(isLocalCodeExecutionAllowed()).toBe(true);
  });

  it("registers no spawn services and only a TASKS stub under store builds", {
    timeout: SLOW,
  }, async () => {
    process.env.ELIZA_BUILD_VARIANT = "store";
    _resetBuildVariantForTests();

    const agentOrchestratorPlugin = createAgentOrchestratorPlugin();
    expect(agentOrchestratorPlugin.services ?? []).toHaveLength(0);
    expect(agentOrchestratorPlugin.providers ?? []).toHaveLength(0);
    const actions = agentOrchestratorPlugin.actions ?? [];
    expect(actions).toHaveLength(1);
    expect(actions[0]?.name).toBe("TASKS");
  });

  it("registers only a TASKS unsupported stub on vanilla Android", {
    timeout: SLOW,
  }, async () => {
    process.env.ELIZA_BUILD_VARIANT = "direct";
    process.env.ELIZA_PLATFORM = "android";
    process.env.ELIZA_RUNTIME_MODE = "local-yolo";
    _resetBuildVariantForTests();

    const agentOrchestratorPlugin = createAgentOrchestratorPlugin();
    expect(agentOrchestratorPlugin.services ?? []).toHaveLength(0);
    expect(agentOrchestratorPlugin.providers ?? []).toHaveLength(0);
    const actions = agentOrchestratorPlugin.actions ?? [];
    expect(actions).toHaveLength(1);
    expect(actions[0]?.name).toBe("TASKS");

    const result = await actions[0]?.handler(
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
    );
    const data = result?.data as { reason?: string } | undefined;
    expect(data?.reason).toBe("MOBILE_TERMINAL_UNSUPPORTED");
    expect(result?.text).toContain("branded AOSP");
  });

  it("returns a structured STORE_BUILD_BLOCKED result from the stub handler", {
    timeout: SLOW,
  }, async () => {
    process.env.ELIZA_BUILD_VARIANT = "store";
    _resetBuildVariantForTests();
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
