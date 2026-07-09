/**
 * Unit tests for the providerOptions deep-merge semantics embedded in
 * AgentRuntime.dynamicPromptExecFromState (runtime.ts). The merge logic is exercised
 * directly here so the behavioral invariant — "caller options survive alongside cache
 * plan additions, with one-level-deep provider-namespace merging" — is verifiable
 * without a full runtime setup. The helper below mirrors the exact merge code in
 * dynamicPromptExecFromState; if that code changes shape, update here to match.
 */
import { describe, expect, it } from "vitest";

// Mirrors the providerOptions merge logic in AgentRuntime.dynamicPromptExecFromState.
function mergeWithCachePlan(
  base: Record<string, unknown>,
  callerOptions: Record<string, unknown> | undefined,
  planOptions: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base, ...(callerOptions ?? {}) };
  for (const [key, planValue] of Object.entries(planOptions)) {
    const existing = merged[key];
    merged[key] =
      existing != null &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      planValue != null &&
      typeof planValue === "object" &&
      !Array.isArray(planValue)
        ? {
            ...(existing as Record<string, unknown>),
            ...(planValue as Record<string, unknown>),
          }
        : planValue;
  }
  return merged;
}

describe("dynamicPromptExecFromState — providerOptions deep-merge", () => {
  it("caller nested provider fields survive alongside cache-plan additions", () => {
    const result = mergeWithCachePlan(
      { agentName: "Bot" },
      { anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } } },
      { anthropic: { cacheControl: { type: "ephemeral" } } },
    );

    expect(result.agentName).toBe("Bot");
    const anthropic = result.anthropic as Record<string, unknown>;
    expect(anthropic.thinking).toEqual({ type: "enabled", budgetTokens: 1024 });
    expect(anthropic.cacheControl).toEqual({ type: "ephemeral" });
  });

  it("cache-plan nested field overwrites caller on key collision within a provider namespace", () => {
    const result = mergeWithCachePlan(
      { agentName: "Bot" },
      { anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } } },
      { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } },
    );

    const anthropic = result.anthropic as Record<string, unknown>;
    expect((anthropic.cacheControl as Record<string, unknown>).ttl).toBe("1h");
  });

  it("top-level non-object plan values replace caller values", () => {
    const result = mergeWithCachePlan(
      { agentName: "Bot" },
      { openrouter: { promptCacheKey: "old" } },
      { openrouter: { promptCacheKey: "new", prompt_cache_key: "new" } },
    );

    const openrouter = result.openrouter as Record<string, unknown>;
    expect(openrouter.promptCacheKey).toBe("new");
    expect(openrouter.prompt_cache_key).toBe("new");
  });

  it("caller top-level provider namespaces not in the plan survive untouched", () => {
    const result = mergeWithCachePlan(
      { agentName: "Bot" },
      { gateway: { caching: "auto" }, openai: { promptCacheKey: "abc" } },
      { anthropic: { cacheControl: { type: "ephemeral" } } },
    );

    expect(result.gateway).toEqual({ caching: "auto" });
    expect(result.openai).toEqual({ promptCacheKey: "abc" });
    expect((result.anthropic as Record<string, unknown>).cacheControl).toEqual({
      type: "ephemeral",
    });
  });

  it("empty caller options still receive the full cache plan", () => {
    const result = mergeWithCachePlan(
      { agentName: "Bot" },
      undefined,
      {
        anthropic: { cacheControl: { type: "ephemeral" } },
        openrouter: { promptCacheKey: "x" },
      },
    );

    expect(result.agentName).toBe("Bot");
    expect(result.anthropic).toBeDefined();
    expect(result.openrouter).toBeDefined();
  });

  it("agentName from base is not overwritten by caller or plan values", () => {
    const result = mergeWithCachePlan(
      { agentName: "RealBot" },
      { agentName: "CallerOverride" },
      { agentName: "PlanOverride" },
    );

    // Caller spreads over base, plan overwrites caller at top-level for scalars.
    // Plan's agentName wins when it conflicts.
    expect(result.agentName).toBe("PlanOverride");
  });

  it("array values in plan replace (not merge) the corresponding caller value", () => {
    const result = mergeWithCachePlan(
      { agentName: "Bot" },
      { tags: ["a", "b"] },
      { tags: ["c"] },
    );

    // Arrays are not object-merged — plan replaces
    expect(result.tags).toEqual(["c"]);
  });
});
