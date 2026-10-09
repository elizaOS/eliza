/** Exercises plan authority against the runtime's real SQLite role store. */

import { ChannelType, type Memory, type UUID } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import { PlanningService } from "./planning-service.ts";

it.each([false, true])(
  "reports denied plans as failures and rechecks retries (initially authorized: %s)",
  async (authorized) => {
    const runtime = createSQLiteTestRuntime({
      character: { name: "Plan authority", bio: [] },
      logLevel: "fatal",
    });
    try {
      await runtime.initialize();
      const worldId = "11111111-1111-4111-8111-111111111111" as UUID;
      const roomId = "22222222-2222-4222-8222-222222222222" as UUID;
      const entityId = "33333333-3333-4333-8333-333333333333" as UUID;
      const world = {
        id: worldId,
        agentId: runtime.agentId,
        name: "Authority",
        metadata: { roles: { [entityId]: authorized ? "ADMIN" : "GUEST" } },
      };
      await runtime.createWorlds([world]);
      await runtime.createRooms([
        {
          id: roomId,
          agentId: runtime.agentId,
          worldId,
          source: "test",
          type: ChannelType.GROUP,
        },
      ]);
      let calls = 0;
      runtime.registerAction({
        name: "PLAN_AUTHORITY_READ",
        description: "Test read",
        similes: [],
        examples: [],
        tags: ["capability:read", "effect:idempotent"],
        roleGate: { minRole: "ADMIN" },
        validate: async () => true,
        handler: async () => {
          calls++;
          if (calls === 1) {
            await runtime.updateWorlds([
              { ...world, metadata: { roles: { [entityId]: "GUEST" } } },
            ]);
            throw new Error("Retry after authority changed");
          }
          return { success: true };
        },
      });
      const message: Memory = {
        id: "44444444-4444-4444-8444-444444444444" as UUID,
        agentId: runtime.agentId,
        entityId,
        roomId,
        worldId,
        content: { text: "Read", source: "test" },
      };
      const service = new PlanningService(runtime);
      const plan = await service.createSimplePlan(
        runtime,
        message,
        { values: {}, data: {}, text: "" },
        { text: "Read", actions: ["PLAN_AUTHORITY_READ"] },
      );
      plan.steps[0].retryPolicy = {
        maxRetries: 2,
        backoffMs: 1,
        backoffMultiplier: 1,
        onError: "abort",
      };
      const result = await service.executePlan(runtime, plan, message);
      expect(calls).toBe(authorized ? 1 : 0);
      expect(result.success).toBe(false);
      expect(result.errors?.length).toBeGreaterThan(0);
    } finally {
      await runtime.stop();
      await runtime.close();
    }
  },
);
