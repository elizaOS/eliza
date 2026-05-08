/**
 * Tests for feat/performance-optimizations branch.
 * Run: SKIP_SERVER_CHECK=true bun test tests/unit/performance-optimizations.test.ts
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { Action, IAgentRuntime, Memory, State } from "@elizaos/core";
import {
  actionsProvider as importedActionsProvider,
  invalidateActionValidationCache as importedInvalidateActionValidationCache,
} from "@/lib/eliza/plugin-cloud-bootstrap/providers/actions";

// ─── Action Validation Cache ─────────────────────────────────────────────────

describe("Action validation cache", () => {
  let actionsProvider = importedActionsProvider;
  let invalidateActionValidationCache = importedInvalidateActionValidationCache;

  beforeEach(() => {
    // Module-level cache is a singleton — tests use unique message IDs to avoid interference.
    actionsProvider = importedActionsProvider;
    invalidateActionValidationCache = importedInvalidateActionValidationCache;
  });

  function makeRuntime(actions: Action[], mcpToolCount?: number): IAgentRuntime {
    return {
      actions,
      getService: () =>
        mcpToolCount !== undefined
          ? {
              getTier2Index: () => ({ getToolCount: () => mcpToolCount }),
            }
          : undefined,
    } as unknown as IAgentRuntime;
  }

  function makeMessage(id: string): Memory {
    return {
      id,
      content: { text: "test" },
      roomId: "room-1",
      entityId: "entity-1",
    } as unknown as Memory;
  }

  const emptyState = { values: {}, data: {}, text: "" } as State;
  const noopHandler: Action["handler"] = async () => undefined;

  type ProviderSnapshot = { data?: unknown; values?: unknown };

  function providerActionsData(state: ProviderSnapshot): { name: string }[] {
    expect(state.data).toBeDefined();
    return (state.data as { actionsData: { name: string }[] }).actionsData;
  }

  function providerValues(state: ProviderSnapshot): Record<string, string> {
    expect(state.values).toBeDefined();
    return state.values as Record<string, string>;
  }

  test("returns validated actions, filters out invalid ones", async () => {
    const validAction: Action = {
      name: "TEST_ACTION",
      description: "A test action",
      validate: async () => true,
      handler: noopHandler,
      similes: [],
      examples: [],
    };
    const invalidAction: Action = {
      name: "INVALID_ACTION",
      description: "Should be filtered",
      validate: async () => false,
      handler: noopHandler,
      similes: [],
      examples: [],
    };

    const result = await actionsProvider.get!(
      makeRuntime([validAction, invalidAction]),
      makeMessage("msg-validate-1"),
      emptyState,
    );

    expect(providerActionsData(result)).toHaveLength(1);
    expect(providerActionsData(result)[0].name).toBe("TEST_ACTION");
  });

  test("caches results — same message ID validates only once", async () => {
    let validateCallCount = 0;
    const action: Action = {
      name: "COUNTED_ACTION",
      description: "Counts validate calls",
      validate: async () => {
        validateCallCount++;
        return true;
      },
      handler: noopHandler,
      similes: [],
      examples: [],
    };

    const runtime = makeRuntime([action]);
    const message = makeMessage("msg-cache-hit-1");

    await actionsProvider.get!(runtime, message, emptyState);
    await actionsProvider.get!(runtime, message, emptyState);
    await actionsProvider.get!(runtime, message, emptyState);
    expect(validateCallCount).toBe(1);
  });

  test("different message IDs produce separate cache entries", async () => {
    let validateCallCount = 0;
    const action: Action = {
      name: "COUNTED_2",
      description: "test",
      validate: async () => {
        validateCallCount++;
        return true;
      },
      handler: noopHandler,
      similes: [],
      examples: [],
    };

    const runtime = makeRuntime([action]);
    await actionsProvider.get!(runtime, makeMessage("msg-a"), emptyState);
    await actionsProvider.get!(runtime, makeMessage("msg-b"), emptyState);
    expect(validateCallCount).toBe(2);
  });

  test("invalidateActionValidationCache forces re-validation", async () => {
    let validateCallCount = 0;
    const action: Action = {
      name: "INVALIDATE_TEST",
      description: "test",
      validate: async () => {
        validateCallCount++;
        return true;
      },
      handler: noopHandler,
      similes: [],
      examples: [],
    };

    const runtime = makeRuntime([action]);
    const message = makeMessage("msg-invalidate-1");

    await actionsProvider.get!(runtime, message, emptyState);
    invalidateActionValidationCache("msg-invalidate-1");
    await actionsProvider.get!(runtime, message, emptyState);
    expect(validateCallCount).toBe(2);
  });

  test("invalidation of non-existent key does not throw", () => {
    expect(() => invalidateActionValidationCache("nonexistent")).not.toThrow();
  });

  test("action throwing during validation is filtered out, others survive", async () => {
    const goodAction: Action = {
      name: "GOOD",
      description: "Works",
      validate: async () => true,
      handler: noopHandler,
      similes: [],
      examples: [],
    };
    const badAction: Action = {
      name: "BAD",
      description: "Throws",
      validate: async () => {
        throw new Error("boom");
      },
      handler: noopHandler,
      similes: [],
      examples: [],
    };

    const result = await actionsProvider.get!(
      makeRuntime([goodAction, badAction]),
      makeMessage("msg-error-1"),
      emptyState,
    );
    expect(providerActionsData(result)).toHaveLength(1);
    expect(providerActionsData(result)[0].name).toBe("GOOD");
  });

  test("caches discoverable tool count from MCP service", async () => {
    const action: Action = {
      name: "MCP_TEST",
      description: "test",
      validate: async () => true,
      handler: noopHandler,
      similes: [],
      examples: [],
    };

    const result = await actionsProvider.get!(
      makeRuntime([action], 42),
      makeMessage("msg-mcp-count-1"),
      emptyState,
    );
    expect(providerValues(result).discoverableToolCount).toBe("42");
  });

  test("handles missing MCP service gracefully", async () => {
    const action: Action = {
      name: "NO_MCP",
      description: "test",
      validate: async () => true,
      handler: noopHandler,
      similes: [],
      examples: [],
    };
    const runtime = {
      actions: [action],
      getService: () => undefined,
    } as unknown as IAgentRuntime;

    const result = await actionsProvider.get!(runtime, makeMessage("msg-no-mcp-1"), emptyState);
    expect(providerValues(result).discoverableToolCount).toBe("");
  });

  test("no validated actions returns empty values", async () => {
    const action: Action = {
      name: "NEVER_VALID",
      description: "test",
      validate: async () => false,
      handler: noopHandler,
      similes: [],
      examples: [],
    };

    const result = await actionsProvider.get!(
      makeRuntime([action]),
      makeMessage("msg-empty-1"),
      emptyState,
    );
    expect(providerActionsData(result)).toHaveLength(0);
    expect(providerValues(result).actionsWithParams).toBe("");
  });

  test("parallel calls after cache is warm all return same data", async () => {
    let validateCallCount = 0;
    const action: Action = {
      name: "CONCURRENT",
      description: "test",
      validate: async () => {
        validateCallCount++;
        await new Promise((r) => setTimeout(r, 50));
        return true;
      },
      handler: noopHandler,
      similes: [],
      examples: [],
    };

    const runtime = makeRuntime([action]);
    const message = makeMessage("msg-concurrent-1");

    await actionsProvider.get!(runtime, message, emptyState);

    const [r1, r2, r3] = await Promise.all([
      actionsProvider.get!(runtime, message, emptyState),
      actionsProvider.get!(runtime, message, emptyState),
      actionsProvider.get!(runtime, message, emptyState),
    ]);

    expect(validateCallCount).toBe(1);
    expect(providerActionsData(r1)).toEqual(providerActionsData(r2));
    expect(providerActionsData(r2)).toEqual(providerActionsData(r3));
  });

  test("concurrent calls on cold cache cause redundant validation (known trade-off)", async () => {
    let validateCallCount = 0;
    const action: Action = {
      name: "COLD_CONCURRENT",
      description: "test",
      validate: async () => {
        validateCallCount++;
        await new Promise((r) => setTimeout(r, 30));
        return true;
      },
      handler: noopHandler,
      similes: [],
      examples: [],
    };

    const runtime = makeRuntime([action]);
    const message = makeMessage("msg-cold-concurrent-1");

    const [r1, r2, r3] = await Promise.all([
      actionsProvider.get!(runtime, message, emptyState),
      actionsProvider.get!(runtime, message, emptyState),
      actionsProvider.get!(runtime, message, emptyState),
    ]);

    // All 3 see !cached and run validation independently — this is the known trade-off.
    // Correctness is preserved: all return valid data, just redundant work.
    expect(validateCallCount).toBeGreaterThanOrEqual(2);
    expect(providerActionsData(r1)).toHaveLength(1);
    expect(providerActionsData(r2)).toHaveLength(1);
    expect(providerActionsData(r3)).toHaveLength(1);
  });

  test("invalidation clears the stale eviction timer before recaching", async () => {
    let validateCallCount = 0;
    const action: Action = {
      name: "STALE_TIMER",
      description: "test",
      validate: async () => {
        validateCallCount++;
        return true;
      },
      handler: noopHandler,
      similes: [],
      examples: [],
    };

    const runtime = makeRuntime([action]);
    const message = makeMessage("msg-stale-timer-1");
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const clearedHandles: unknown[] = [];

    globalThis.setTimeout = (() => ({
      id: Symbol("timer"),
      unref: () => undefined,
    })) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
      clearedHandles.push(handle);
    }) as typeof clearTimeout;

    try {
      await actionsProvider.get!(runtime, message, emptyState);
      expect(validateCallCount).toBe(1);

      invalidateActionValidationCache("msg-stale-timer-1");
      expect(clearedHandles).toHaveLength(1);

      await actionsProvider.get!(runtime, message, emptyState);
      expect(validateCallCount).toBe(2);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test("undefined message.id works but skips cache", async () => {
    let validateCallCount = 0;
    const action: Action = {
      name: "EDGE",
      description: "test",
      validate: async () => {
        validateCallCount++;
        return true;
      },
      handler: noopHandler,
      similes: [],
      examples: [],
    };
    const runtime = {
      actions: [action],
      getService: () => undefined,
    } as unknown as IAgentRuntime;
    const msg = {
      id: undefined,
      content: { text: "test" },
      roomId: "r",
      entityId: "e",
    } as unknown as Memory;

    const r1 = await actionsProvider.get!(runtime, msg, emptyState);
    expect(providerActionsData(r1)).toHaveLength(1);

    const r2 = await actionsProvider.get!(runtime, msg, emptyState);
    expect(providerActionsData(r2)).toHaveLength(1);
    expect(validateCallCount).toBe(2);
  });
});

// ─── Cache Invalidation Flow ─────────────────────────────────────────────────

describe("Cache invalidation flow", () => {
  test("message service imports invalidateActionValidationCache", async () => {
    const source = await Bun.file(
      "packages/lib/eliza/plugin-cloud-bootstrap/services/cloud-bootstrap-message-service.ts",
    ).text();
    expect(source).toContain(
      'import { invalidateActionValidationCache } from "../providers/actions"',
    );
  });

  test("invalidation is called inside SEARCH_ACTIONS success path", async () => {
    const source = await Bun.file(
      "packages/lib/eliza/plugin-cloud-bootstrap/services/cloud-bootstrap-message-service.ts",
    ).text();
    const match = source.match(
      /if \(action === "SEARCH_ACTIONS"[\s\S]*?if \(message\.id\) \{[\s\S]*?invalidateActionValidationCache\(String\(message\.id\)\)/,
    );
    expect(match).not.toBeNull();
  });
});

// ─── Retry Config ────────────────────────────────────────────────────────────

describe("Retry config", () => {
  let sourceRetryConfig: {
    baseDelayMs: number;
    maxDelayMs: number;
    backoffMultiplier: number;
  };

  beforeEach(async () => {
    const source = await Bun.file(
      "packages/lib/eliza/plugin-cloud-bootstrap/services/cloud-bootstrap-message-service.ts",
    ).text();

    sourceRetryConfig = {
      baseDelayMs: Number(source.match(/baseDelayMs:\s*(\d+)/)![1]),
      maxDelayMs: Number(source.match(/maxDelayMs:\s*(\d+)/)![1]),
      backoffMultiplier: Number(source.match(/backoffMultiplier:\s*(\d+)/)![1]),
    };
  });

  test("source values are baseDelayMs=200, maxDelayMs=1000, multiplier=2", () => {
    expect(sourceRetryConfig.baseDelayMs).toBe(200);
    expect(sourceRetryConfig.maxDelayMs).toBe(1000);
    expect(sourceRetryConfig.backoffMultiplier).toBe(2);
  });

  test("backoff sequence caps at maxDelayMs", () => {
    const { baseDelayMs, maxDelayMs, backoffMultiplier } = sourceRetryConfig;
    const delay = (attempt: number) =>
      Math.min(baseDelayMs * backoffMultiplier ** (attempt - 1), maxDelayMs);

    expect(delay(1)).toBe(200);
    expect(delay(2)).toBe(400);
    expect(delay(3)).toBe(800);
    expect(delay(4)).toBe(1000); // Capped
  });

  test("delay never exceeds max even at extreme attempt numbers", () => {
    const { baseDelayMs, maxDelayMs, backoffMultiplier } = sourceRetryConfig;
    for (let attempt = 1; attempt <= 100; attempt++) {
      const delay = Math.min(baseDelayMs * backoffMultiplier ** (attempt - 1), maxDelayMs);
      expect(delay).toBeLessThanOrEqual(maxDelayMs);
      expect(Number.isFinite(delay)).toBe(true);
    }
  });
});

// ─── Native Planner Template ─────────────────────────────────────────────────

describe("native planner template", () => {
  let decisionTemplate: string;
  let summaryTemplate: string;

  beforeEach(async () => {
    const mod = await import("@/lib/eliza/plugin-cloud-bootstrap/templates/native-planner");
    decisionTemplate = mod.nativePlannerTemplate;
    summaryTemplate = mod.nativeResponseTemplate;
  });

  test("contains minimize-iterations and terminal response rules", () => {
    expect(decisionTemplate).toContain("Minimize iterations");
    expect(decisionTemplate).toContain(
      "Most tasks need only 1 action plus a terminal messageToUser",
    );
    expect(decisionTemplate).toContain("Return messageToUser soon");
    expect(decisionTemplate).toContain("Do NOT add extra iterations");
  });

  test("uses native JSON output without XML planner envelopes", () => {
    expect(decisionTemplate).toContain("toolCalls");
    expect(decisionTemplate).toContain("messageToUser");
    expect(decisionTemplate).toContain("Do not wrap args in action-name keys");
    expect(decisionTemplate).not.toContain("<system>");
    expect(decisionTemplate).not.toContain("<task>");
    expect(decisionTemplate).not.toContain("<output>");
  });

  test("preserves execute-actions rule from ux-overhaul", () => {
    expect(decisionTemplate).toContain("Always execute actions for user requests");
  });

  test("all 7 rules present and numbered", () => {
    expect(decisionTemplate).toContain("1. **Single action per step**");
    expect(decisionTemplate).toContain("2. **No redundancy**");
    expect(decisionTemplate).toContain("3. **Parameter extraction**");
    expect(decisionTemplate).toContain("4. **Tool discovery**");
    expect(decisionTemplate).toContain("5. **Completion**");
    expect(decisionTemplate).toContain("6. **Minimize iterations**");
    expect(decisionTemplate).toContain("7. **Always execute actions");
  });

  test("summary template preserves URL and next-step guidelines", () => {
    expect(summaryTemplate).toContain("Preserve URLs");
    expect(summaryTemplate).toContain("Clear next step");
  });
});

// ─── MCP Timeout ─────────────────────────────────────────────────────────────

describe("MCP timeout constant", () => {
  test("DEFAULT_MCP_TIMEOUT_MS is 15000ms", async () => {
    const { DEFAULT_MCP_TIMEOUT_MS } = await import("@/lib/eliza/plugin-mcp/types");
    expect(DEFAULT_MCP_TIMEOUT_MS).toBe(15000);
  });

  test("other MCP constants unchanged", async () => {
    const { DEFAULT_MAX_RETRIES, MAX_RECONNECT_ATTEMPTS, BACKOFF_MULTIPLIER, INITIAL_RETRY_DELAY } =
      await import("@/lib/eliza/plugin-mcp/types");

    expect(DEFAULT_MAX_RETRIES).toBe(2);
    expect(MAX_RECONNECT_ATTEMPTS).toBe(5);
    expect(BACKOFF_MULTIPLIER).toBe(2);
    expect(INITIAL_RETRY_DELAY).toBe(2000);
  });

  test("service uses the millisecond timeout constant when timeoutInMillis is absent", async () => {
    const source = await Bun.file("packages/lib/eliza/plugin-mcp/service.ts").text();
    expect(source).toContain("config.timeoutInMillis || DEFAULT_MCP_TIMEOUT_MS");
  });
});

// ─── Parse Retry Defaults ────────────────────────────────────────────────────

describe("Parse retry defaults", () => {
  test("NATIVE_PLANNER_PARSE_RETRIES default is '2'", async () => {
    const source = await Bun.file(
      "packages/lib/eliza/plugin-cloud-bootstrap/services/cloud-bootstrap-message-service.ts",
    ).text();
    const match = source.match(/NATIVE_PLANNER_PARSE_RETRIES.*?\?\?\s*"(\d+)"/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("2");
  });

  test("NATIVE_RESPONSE_PARSE_RETRIES default is '2'", async () => {
    const source = await Bun.file(
      "packages/lib/eliza/plugin-cloud-bootstrap/services/cloud-bootstrap-message-service.ts",
    ).text();
    const match = source.match(/NATIVE_RESPONSE_PARSE_RETRIES.*?\?\?\s*"(\d+)"/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("2");
  });
});

// ─── MCP Wait Removal ────────────────────────────────────────────────────────

describe("MCP wait removal", () => {
  test("waitForInitialization removed from message service", async () => {
    const source = await Bun.file(
      "packages/lib/eliza/plugin-cloud-bootstrap/services/cloud-bootstrap-message-service.ts",
    ).text();
    expect(source).not.toContain("waitForInitialization");
  });

  test("RuntimeFactory still calls waitForMcpServiceIfNeeded", async () => {
    const source = await Bun.file("packages/lib/eliza/runtime-factory.ts").text();
    expect(source).toContain("waitForMcpServiceIfNeeded");
    expect(source).toContain("waitForInitialization");
  });
});
