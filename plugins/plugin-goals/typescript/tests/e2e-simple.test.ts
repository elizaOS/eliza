import type { IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import GoalsPlugin from "../index";
import { createGoalDataService } from "../services/goalDataService";

// Helper function to create a minimal mock runtime for testing
function createMockRuntime(): IAgentRuntime {
  return {
    agentId: "test-agent-uuid-1234-5678-abcd" as UUID,
    db: {
      execute: () => Promise.resolve([]),
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([]),
        }),
      }),
      insert: () => ({
        values: () => ({
          returning: () => Promise.resolve([{ id: "test-id" }]),
        }),
      }),
    },
    getService: () => null,
    useModel: () => Promise.resolve("Mock response"),
    composeState: () => Promise.resolve({ data: {} }),
    getRoom: () => Promise.resolve(null),
    emitEvent: () => Promise.resolve(),
  } as Partial<IAgentRuntime> as IAgentRuntime;
}

// Mock runtime for testing
const agentRuntime = createMockRuntime();

describe("Goals Plugin E2E Simple Tests", () => {
  it("should initialize plugin successfully", async () => {
    expect(() => GoalsPlugin.init?.({}, agentRuntime)).not.toThrow();
  });

  it("should have working action validation", () => {
    const createAction = GoalsPlugin.actions?.find((a) => a.name === "CREATE_GOAL");
    expect(createAction).toBeDefined();
    expect(createAction?.validate).toBeDefined();
    expect(typeof createAction?.handler).toBe("function");
  });

  it("should export all required types", () => {
    expect(typeof GoalsPlugin.name).toBe("string");
    expect(Array.isArray(GoalsPlugin.actions)).toBe(true);
    expect(Array.isArray(GoalsPlugin.services)).toBe(true);
    expect(Array.isArray(GoalsPlugin.providers)).toBe(true);
    expect(GoalsPlugin.schema).toBeDefined();
  });

  it("should create goal data service successfully", () => {
    const dataService = createGoalDataService(agentRuntime);
    expect(dataService).toBeDefined();
  });
});
