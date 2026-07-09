/**
 * Tests the training runtime hook that consumes optimized contextConfig
 * artifacts. The fake runtime captures the pipeline hook directly so the test
 * proves provider selection/order without booting cron jobs or model services.
 */
import {
  OPTIMIZED_PROMPT_SERVICE,
  OptimizedPromptService,
  type PipelineHookSpec,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  OPTIMIZED_CONTEXT_CONFIG_HOOK_ID,
  registerOptimizedContextConfigHook,
} from "./register-runtime.js";

function serviceWithContextConfig(
  task: "context_routing" | "action_planner",
): OptimizedPromptService {
  const service = new OptimizedPromptService();
  const writable = service as unknown as {
    cache: Record<string, unknown>;
  };
  writable.cache[task] = {
    loadedAt: Date.now(),
    artifact: {
      task,
      optimizer: "gepa",
      baseline: "baseline",
      prompt: "optimized",
      score: 0.9,
      baselineScore: 0.5,
      datasetId: "fixture",
      datasetSize: 3,
      generatedAt: "2026-07-09T00:00:00.000Z",
      lineage: [],
      contextConfig: {
        providerSet: ["RECENT_MESSAGES", "FACTS"],
        providerOrder: ["FACTS", "RECENT_MESSAGES"],
      },
    },
  };
  return service;
}

function fakeRuntime(service: OptimizedPromptService): {
  runtime: {
    getService: (name: string) => unknown;
    registerPipelineHook: (spec: PipelineHookSpec) => void;
    unregisterPipelineHook: (id: string) => void;
  };
  hooks: PipelineHookSpec[];
  unregistered: string[];
} {
  const hooks: PipelineHookSpec[] = [];
  const unregistered: string[] = [];
  return {
    hooks,
    unregistered,
    runtime: {
      getService(name: string) {
        return name === OPTIMIZED_PROMPT_SERVICE ? service : null;
      },
      registerPipelineHook(spec: PipelineHookSpec) {
        hooks.push(spec);
      },
      unregisterPipelineHook(id: string) {
        unregistered.push(id);
      },
    },
  };
}

describe("registerOptimizedContextConfigHook", () => {
  it("registers a compose_state_providers hook that filters and orders eligible providers", async () => {
    const { runtime, hooks, unregistered } = fakeRuntime(
      serviceWithContextConfig("context_routing"),
    );
    registerOptimizedContextConfigHook(runtime as never);

    expect(unregistered).toEqual([OPTIMIZED_CONTEXT_CONFIG_HOOK_ID]);
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({
      id: OPTIMIZED_CONTEXT_CONFIG_HOOK_ID,
      phase: "compose_state_providers",
      mutatesPrimary: true,
    });

    const ctx = {
      phase: "compose_state_providers" as const,
      providers: {
        current: ["ACTIONS", "RECENT_MESSAGES", "FACTS", "PLATFORM"],
      },
      onlyInclude: false,
      activeContexts: [],
      includeList: null,
      message: {},
    };
    await hooks[0].handler(runtime as never, ctx as never);

    expect(ctx.providers.current).toEqual(["FACTS", "RECENT_MESSAGES"]);
  });

  it("leaves exact include-list compose calls untouched", async () => {
    const { runtime, hooks } = fakeRuntime(
      serviceWithContextConfig("context_routing"),
    );
    registerOptimizedContextConfigHook(runtime as never);
    const ctx = {
      phase: "compose_state_providers" as const,
      providers: { current: ["ACTIONS", "RECENT_MESSAGES", "FACTS"] },
      onlyInclude: true,
      activeContexts: [],
      includeList: ["ACTIONS"],
      message: {},
    };

    await hooks[0].handler(runtime as never, ctx as never);

    expect(ctx.providers.current).toEqual([
      "ACTIONS",
      "RECENT_MESSAGES",
      "FACTS",
    ]);
  });

  it("falls back to action_planner contextConfig when no context_routing artifact exists", async () => {
    const { runtime, hooks } = fakeRuntime(
      serviceWithContextConfig("action_planner"),
    );
    registerOptimizedContextConfigHook(runtime as never);
    const ctx = {
      phase: "compose_state_providers" as const,
      providers: { current: ["RECENT_MESSAGES", "FACTS", "ACTIONS"] },
      onlyInclude: false,
      activeContexts: [],
      includeList: null,
      message: {},
    };

    await hooks[0].handler(runtime as never, ctx as never);

    expect(ctx.providers.current).toEqual(["FACTS", "RECENT_MESSAGES"]);
  });
});
