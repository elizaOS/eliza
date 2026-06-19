import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { IAgentRuntime } from "@elizaos/core";
import {
  autonomousCommentingService,
  autonomousDMService,
  autonomousPlanningCoordinator,
  type PlannedAction,
} from "@feed/agents";
import type { JsonValue } from "@feed/api";

type ExecuteActionFn = (
  agentUserId: string,
  runtime: IAgentRuntime,
  action: PlannedAction,
) => Promise<{ success: boolean; data?: JsonValue; error?: string }>;

// Access private executeAction method for testing
// Type assertion needed to access private method for testing purposes
// The executeAction method exists on AutonomousPlanningCoordinator but is private
// Use 'as unknown as' to bypass TypeScript's intersection type reduction to 'never'
type CoordinatorWithExecuteAction = {
  executeAction: ExecuteActionFn;
};
const coordinator =
  autonomousPlanningCoordinator as unknown as CoordinatorWithExecuteAction;

describe("AutonomousPlanningCoordinator executeAction", () => {
  const runtime = {} as IAgentRuntime;
  let originalCommentFn: typeof autonomousCommentingService.createAgentComment;
  let originalDMFn: typeof autonomousDMService.respondToDMs;

  beforeEach(() => {
    originalCommentFn = autonomousCommentingService.createAgentComment;
    originalDMFn = autonomousDMService.respondToDMs;
  });

  afterEach(() => {
    autonomousCommentingService.createAgentComment = originalCommentFn;
    autonomousDMService.respondToDMs = originalDMFn;
  });

  test("executes comment action via commenting service", async () => {
    const spy = mock<typeof autonomousCommentingService.createAgentComment>(
      () => Promise.resolve("comment-1"),
    );
    autonomousCommentingService.createAgentComment = spy;

    const action: PlannedAction = {
      type: "comment",
      priority: 5,
      reasoning: "Engage community",
      estimatedImpact: 0.2,
      params: {},
    };

    const result = await coordinator.executeAction("agent-1", runtime, action);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ commentId: "comment-1" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("fails comment action when no comment generated", async () => {
    const spy = mock<typeof autonomousCommentingService.createAgentComment>(
      () => Promise.resolve(null),
    );
    autonomousCommentingService.createAgentComment = spy;

    const action: PlannedAction = {
      type: "comment",
      priority: 4,
      reasoning: "No opportunities",
      estimatedImpact: 0.1,
      params: {},
    };

    const result = await coordinator.executeAction("agent-1", runtime, action);

    expect(result.success).toBe(false);
    expect(result.error).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("executes message action via DM service", async () => {
    const spy = mock<typeof autonomousDMService.respondToDMs>(() =>
      Promise.resolve(2),
    );
    autonomousDMService.respondToDMs = spy;

    const action: PlannedAction = {
      type: "message",
      priority: 7,
      reasoning: "Follow up with users",
      estimatedImpact: 0.3,
      params: {},
    };

    const result = await coordinator.executeAction("agent-2", runtime, action);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ responses: 2 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("handles message action when no responses sent", async () => {
    const spy = mock<typeof autonomousDMService.respondToDMs>(() =>
      Promise.resolve(0),
    );
    autonomousDMService.respondToDMs = spy;

    const action: PlannedAction = {
      type: "message",
      priority: 6,
      reasoning: "No unread DMs",
      estimatedImpact: 0.05,
      params: {},
    };

    const result = await coordinator.executeAction("agent-3", runtime, action);

    expect(result.success).toBe(false);
    expect(result.data).toEqual({ responses: 0 });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
