/**
 * Exercises the exported A2A skill handlers at their untrusted data boundary.
 * The real handlers must preserve zero, apply defaults and caps, and reject
 * malformed limits before invoking their service collaborators.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { PLATFORM_MCP_TOOL_PRICING } from "../../../billing/mcp-pricing";
import type { RetrieveMemoriesInput } from "../../services/memory";
import type { A2AContext } from "./types";

const usageLimits: number[] = [];
const memoryInputs: RetrieveMemoriesInput[] = [];
const memoryReservations: number[] = [];
const memoryReconciliations: number[] = [];
const listByOrganization = mock(async () =>
  Array.from({ length: 60 }, (_, index) => ({
    id: `agent-${index}`,
    name: `Agent ${index}`,
    bio: [`Bio ${index}`],
    avatar_url: null,
    created_at: new Date(2026, 0, index + 1),
  })),
);

mock.module("../../services/usage", () => ({
  usageService: {
    listByOrganization: async (_organizationId: string, limit: number) => {
      usageLimits.push(limit);
      return [];
    },
  },
}));
mock.module("../../services/characters/characters", () => ({
  charactersService: { listByOrganization },
}));
mock.module("../../services/memory", () => ({
  memoryService: {
    retrieveMemories: async (input: RetrieveMemoriesInput) => {
      memoryInputs.push(input);
      return [];
    },
    saveMemory: async () => ({ memoryId: "memory-1", storage: "database" }),
  },
}));
mock.module("../../services/credits", () => ({
  creditsService: {
    reserve: async ({ amount }: { amount: number }) => {
      memoryReservations.push(amount);
      return {
        reconcile: async (actual: number) => {
          memoryReconciliations.push(actual);
        },
      };
    },
  },
  InsufficientCreditsError: class extends Error {},
}));

const context = {
  apiKeyId: null,
  agentIdentifier: "pagination-test-agent",
  user: {
    id: "user-1",
    organization_id: "org-1",
    organization: { id: "org-1" },
  },
} as A2AContext;

beforeEach(() => {
  usageLimits.length = 0;
  memoryInputs.length = 0;
  memoryReservations.length = 0;
  memoryReconciliations.length = 0;
  listByOrganization.mockClear();
});

describe("A2A skill limit boundary", () => {
  test("get_usage preserves zero, defaults omitted, and caps positive limits", async () => {
    const { executeSkillGetUsage } = await import("./skills");

    await executeSkillGetUsage({ limit: 0 }, context);
    await executeSkillGetUsage({}, context);
    await executeSkillGetUsage({ limit: 80 }, context);

    expect(usageLimits).toEqual([0, 10, 50]);
  });

  test("save_memory reserves and reconciles the canonical advertised USD price", async () => {
    const { executeSkillSaveMemory } = await import("./skills");

    const result = await executeSkillSaveMemory("remember this", { roomId: "room-1" }, context);

    expect(memoryReservations).toEqual([PLATFORM_MCP_TOOL_PRICING.save_memory.priceUsd]);
    expect(memoryReconciliations).toEqual([PLATFORM_MCP_TOOL_PRICING.save_memory.priceUsd]);
    expect(result.cost).toBe(PLATFORM_MCP_TOOL_PRICING.save_memory.priceUsd);
  });

  test("list_agents preserves zero, defaults omitted, and caps positive limits", async () => {
    const { executeSkillListAgents } = await import("./skills");

    const zero = await executeSkillListAgents({ limit: 0 }, context);
    const omitted = await executeSkillListAgents({}, context);
    const capped = await executeSkillListAgents({ limit: 80 }, context);

    expect(zero.agents).toHaveLength(0);
    expect(omitted.agents).toHaveLength(20);
    expect(capped.agents).toHaveLength(50);
    expect(listByOrganization).toHaveBeenCalledTimes(3);
  });

  test("retrieve_memories passes zero, default, and capped limits to MemoryService", async () => {
    const { executeSkillRetrieveMemories } = await import("./skills");

    await executeSkillRetrieveMemories("query-zero", { limit: 0 }, context);
    await executeSkillRetrieveMemories("query-default", {}, context);
    await executeSkillRetrieveMemories("query-capped", { limit: 80 }, context);

    expect(memoryInputs.map((input) => input.limit)).toEqual([0, 10, 50]);
  });

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "2", null])(
    "rejects malformed limit %p before invoking any service",
    async (limit) => {
      const { executeSkillGetUsage, executeSkillListAgents, executeSkillRetrieveMemories } =
        await import("./skills");

      await expect(executeSkillGetUsage({ limit }, context)).rejects.toThrow(
        "limit must be a non-negative safe integer",
      );
      await expect(executeSkillListAgents({ limit }, context)).rejects.toThrow(
        "limit must be a non-negative safe integer",
      );
      await expect(executeSkillRetrieveMemories("query", { limit }, context)).rejects.toThrow(
        "limit must be a non-negative safe integer",
      );

      expect(usageLimits).toEqual([]);
      expect(memoryInputs).toEqual([]);
      expect(listByOrganization).not.toHaveBeenCalled();
    },
  );
});
