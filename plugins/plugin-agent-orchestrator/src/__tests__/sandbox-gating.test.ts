/**
 * Asserts the orchestrator's store-build gating: when ELIZA_BUILD_VARIANT=store,
 * the plugin must register zero spawn-bearing services and a single TASKS stub
 * action whose handler returns a structured "blocked" result without ever
 * touching ACP / workspace state.
 */

import type { Content } from "@elizaos/core";
import {
  _resetBuildVariantForTests,
  getBuildVariant,
  isLocalCodeExecutionAllowed,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTerminalUnsupportedTasksAction,
  tasksSandboxStubAction,
} from "../actions/sandbox-stub.js";
import { createAgentOrchestratorPlugin } from "../index.js";
import type {
  OrchestratorTerminalSupport,
  OrchestratorUnsupportedReason,
} from "../services/terminal-capabilities.js";

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

  it("declares its TTS plugin dependency instead of relying on host name-pair injection", {
    timeout: SLOW,
  }, async () => {
    const agentOrchestratorPlugin = createAgentOrchestratorPlugin();
    expect(agentOrchestratorPlugin.dependencies).toContain(
      "@elizaos/plugin-edge-tts",
    );
  });

  it("registers completion and failure response evaluators under supported direct builds", {
    timeout: SLOW,
  }, async () => {
    process.env.ELIZA_BUILD_VARIANT = "direct";
    process.env.ELIZA_PLATFORM = "desktop";
    _resetBuildVariantForTests();

    const agentOrchestratorPlugin = createAgentOrchestratorPlugin();
    expect(
      (agentOrchestratorPlugin.responseHandlerEvaluators ?? []).map(
        (evaluator) => evaluator.name,
      ),
    ).toEqual([
      "agent-orchestrator.sub-agent-completion",
      "agent-orchestrator.sub-agent-failure",
    ]);
  });

  it("registers only a TASKS unsupported stub on Android without a staged shell", {
    timeout: SLOW,
  }, async () => {
    process.env.ELIZA_BUILD_VARIANT = "direct";
    process.env.ELIZA_PLATFORM = "android";
    process.env.ELIZA_RUNTIME_MODE = "local-yolo";
    process.env.CODING_TOOLS_SHELL = "/definitely/missing";
    process.env.SHELL = "/definitely/missing";
    process.env.PATH = "";
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
    expect(data?.reason).toBe("AOSP_TERMINAL_MISSING_SHELL");
    expect(result?.text).toContain("executable shell");
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

describe("createTerminalUnsupportedTasksAction reason mapping", () => {
  // Each unsupported terminal-support reason must surface a specific,
  // user-facing stub reason code. The default (no reason) collapses to the
  // generic TERMINAL_UNSUPPORTED. Covers the iOS (#9146 AC: "iOS/store
  // surfaces the stub MOBILE_TERMINAL_UNSUPPORTED cleanly") and AOSP
  // non-local-yolo paths that the full-plugin gating test does not exercise.
  const cases: ReadonlyArray<{
    label: string;
    reason: OrchestratorUnsupportedReason | undefined;
    expectedReason: string;
  }> = [
    {
      label: "iOS / vanilla mobile",
      reason: "vanilla_mobile",
      expectedReason: "MOBILE_TERMINAL_UNSUPPORTED",
    },
    {
      label: "Android not in local-yolo mode",
      reason: "not_local_yolo",
      expectedReason: "AOSP_TERMINAL_REQUIRES_LOCAL_YOLO",
    },
    {
      label: "Android missing shell",
      reason: "missing_shell",
      expectedReason: "AOSP_TERMINAL_MISSING_SHELL",
    },
    {
      label: "unknown / no reason",
      reason: undefined,
      expectedReason: "TERMINAL_UNSUPPORTED",
    },
  ];

  for (const { label, reason, expectedReason } of cases) {
    it(`maps ${label} -> ${expectedReason}`, async () => {
      const support: OrchestratorTerminalSupport = {
        supported: false,
        reason,
        message: `terminal unsupported: ${expectedReason}`,
      };

      const action = createTerminalUnsupportedTasksAction(support);

      expect(action.name).toBe("TASKS");
      expect(action.suppressPostActionContinuation).toBe(true);
      expect(await action.validate({} as never, {} as never, undefined)).toBe(
        true,
      );

      let callbackContent: Content | undefined;
      const result = await action.handler(
        {} as never,
        {} as never,
        undefined,
        undefined,
        async (response: Content) => {
          callbackContent = response;
          return [];
        },
      );

      expect(result?.success).toBe(false);
      expect(result?.text).toBe(support.message);
      const data = result?.data as { reason?: string } | undefined;
      expect(data?.reason).toBe(expectedReason);

      expect(callbackContent?.text).toBe(support.message);
      expect(callbackContent?.actions).toEqual(["TASKS"]);
    });
  }
});
