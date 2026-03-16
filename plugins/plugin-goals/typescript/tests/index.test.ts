import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import GoalsPlugin from "../index";

describe("GoalsPlugin", () => {
  it("should export GoalsPlugin with correct structure", () => {
    expect(GoalsPlugin).toBeDefined();
    expect(GoalsPlugin.name).toBe("goals");
    expect(GoalsPlugin.description).toBe(
      "Provides goal management functionality for tracking and achieving objectives."
    );
    expect(GoalsPlugin.providers).toHaveLength(1);
    expect(GoalsPlugin.actions).toHaveLength(5); // 5 actions
    expect(GoalsPlugin.services).toHaveLength(1); // 1 service: goal data service
    expect(GoalsPlugin.routes).toBeDefined();
    expect(GoalsPlugin.init).toBeInstanceOf(Function);
  });

  it("should have all required actions", () => {
    const actionNames = GoalsPlugin.actions?.map((action) => action.name) || [];
    expect(actionNames).toContain("CREATE_GOAL");
    expect(actionNames).toContain("COMPLETE_GOAL");
    expect(actionNames).toContain("CONFIRM_GOAL");
    expect(actionNames).toContain("UPDATE_GOAL");
    expect(actionNames).toContain("CANCEL_GOAL");
  });

  // Helper function to create a minimal mock runtime for testing
  function createMockRuntime(): IAgentRuntime {
    return {
      agentId: "test-agent-uuid-1234-5678-abcd",
      db: {
        execute: vi.fn(),
      },
    } as Partial<IAgentRuntime> as IAgentRuntime;
  }

  it("should initialize without errors", async () => {
    const agentRuntime = createMockRuntime();

    const config = {};
    if (GoalsPlugin.init) {
      await expect(GoalsPlugin.init(config, agentRuntime)).resolves.toBeUndefined();
    }
  });
});
