import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { tasksAction } from "../actions/tasks.ts";

describe("TASKS child assignment boundary", () => {
  for (const action of ["spawn_agent"]) {
    it(`${action} rejects parent-only text before child dispatch`, async () => {
      const runtime = new Proxy(
        {},
        {
          get(_target, name) {
            if (name === "getService") return () => ({});
            throw new Error(`Unexpected runtime access: ${String(name)}`);
          },
        },
      ) as IAgentRuntime;
      const message = {
        id: "11111111-1111-4111-8111-111111111111",
        roomId: "22222222-2222-4222-8222-222222222222",
        entityId: "33333333-3333-4333-8333-333333333333",
        content: { text: "Delegate this request; do not execute it inline." },
      } as Memory;
      const result = await tasksAction.handler(runtime, message, undefined, {
        parameters: { action },
      });
      expect(result).toMatchObject({
        success: false,
        error: "CHILD_TASK_REQUIRED",
      });
      expect(result?.effectReceipts).toHaveLength(1);
      expect(result?.effectReceipts?.[0]).toMatchObject({
        outcome: "failed",
        failure: { code: "CHILD_TASK_REQUIRED", acceptance: "rejected" },
      });
      expect(result?.data?.outcomeUnknown).not.toBe(true);
    });
  }
});
