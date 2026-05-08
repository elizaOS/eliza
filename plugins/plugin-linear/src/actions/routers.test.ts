import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createCommentAction } from "./createComment";
import { createIssueAction } from "./createIssue";
import {
  getLinearRouteForTest,
  linearCommentRouterAction,
  linearIssueRouterAction,
  linearWorkflowRouterAction,
} from "./routers";

function createRuntime(): IAgentRuntime {
  return {
    agentId: "agent-id",
    getSetting: vi.fn((key: string) => (key === "LINEAR_API_KEY" ? "linear-key" : undefined)),
    getService: vi.fn(),
  } as unknown as IAgentRuntime;
}

function createMessage(text: string): Memory {
  return {
    id: "message-id",
    agentId: "agent-id",
    entityId: "entity-id",
    roomId: "room-id",
    content: { text, source: "test" },
  } as unknown as Memory;
}

describe("Linear router actions", () => {
  it("selects issue and workflow subactions from message text", () => {
    expect(getLinearRouteForTest("issue", createMessage("Archive ENG-123"))).toBe("delete");
    expect(getLinearRouteForTest("workflow", createMessage("Search open Linear bugs"))).toBe(
      "search_issues"
    );
  });

  it("honors an explicit issue subaction and annotates delegated results", async () => {
    const handler = vi.spyOn(createIssueAction, "handler").mockResolvedValue({
      success: true,
      text: "created",
      data: { identifier: "ENG-1" },
    });

    const result = await linearIssueRouterAction.handler(
      createRuntime(),
      createMessage("Add a Linear task"),
      undefined,
      { parameters: { subaction: "create" } }
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: true,
      text: "created",
      data: {
        actionName: "LINEAR_ISSUE",
        router: "LINEAR_ISSUE",
        routedActionName: "CREATE_LINEAR_ISSUE",
        op: "create",
        subaction: "create",
        result: { identifier: "ENG-1" },
        identifier: "ENG-1",
      },
    });

    handler.mockRestore();
  });

  it("annotates delegated comment failures with structured error data", async () => {
    const handler = vi.spyOn(createCommentAction, "handler").mockResolvedValue({
      success: false,
      text: "Please provide the comment content.",
      values: { error: "MISSING_COMMENT_BODY" },
    });

    const result = await linearCommentRouterAction.handler(
      createRuntime(),
      createMessage("Comment on ENG-1"),
      undefined,
      { parameters: { subaction: "create" } }
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: false,
      text: "Please provide the comment content.",
      values: { error: "MISSING_COMMENT_BODY" },
      data: {
        actionName: "LINEAR_COMMENT",
        router: "LINEAR_COMMENT",
        routedActionName: "CREATE_LINEAR_COMMENT",
        op: "create",
        subaction: "create",
        error: {
          code: "MISSING_COMMENT_BODY",
          message: "Please provide the comment content.",
        },
      },
    });

    handler.mockRestore();
  });

  it("returns structured workflow errors when no route matches", async () => {
    const result = await linearWorkflowRouterAction.handler(
      createRuntime(),
      createMessage("Linear please do the thing"),
      undefined,
      { parameters: { subaction: "unknown" } }
    );

    expect(result).toMatchObject({
      success: false,
      text: "LINEAR_WORKFLOW requires one of these subactions: clear_activity, get_activity, search_issues.",
      values: { error: "MISSING_SUBACTION" },
      data: {
        actionName: "LINEAR_WORKFLOW",
        router: "LINEAR_WORKFLOW",
        routedActionName: null,
        op: null,
        subaction: null,
        availableSubactions: "clear_activity, get_activity, search_issues",
        error: {
          code: "MISSING_SUBACTION",
          message:
            "LINEAR_WORKFLOW requires one of these subactions: clear_activity, get_activity, search_issues.",
        },
      },
    });
  });

  it("validates router groups when Linear is configured", async () => {
    const runtime = createRuntime();

    await expect(
      linearIssueRouterAction.validate(runtime, createMessage("Update issue ENG-2"))
    ).resolves.toBe(true);
    await expect(
      linearWorkflowRouterAction.validate(runtime, createMessage("Show Linear activity"))
    ).resolves.toBe(true);
  });
});
