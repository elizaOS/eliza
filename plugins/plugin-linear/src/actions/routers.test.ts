import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createIssueAction } from "./createIssue";
import {
  getLinearRouteForTest,
  linearIssueRouterAction,
  linearProjectTeamRouterAction,
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
  it("selects issue, project/team, and workflow subactions from message text", () => {
    expect(getLinearRouteForTest("issue", createMessage("Archive ENG-123"))).toBe("delete");
    expect(getLinearRouteForTest("project_team", createMessage("Show Linear projects"))).toBe(
      "list_projects"
    );
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
      data: {
        actionName: "LINEAR_ISSUE",
        routedActionName: "CREATE_LINEAR_ISSUE",
        subaction: "create",
        identifier: "ENG-1",
      },
    });

    handler.mockRestore();
  });

  it("validates router groups when Linear is configured", async () => {
    const runtime = createRuntime();

    await expect(
      linearIssueRouterAction.validate(runtime, createMessage("Update issue ENG-2"))
    ).resolves.toBe(true);
    await expect(
      linearProjectTeamRouterAction.validate(runtime, createMessage("List Linear teams"))
    ).resolves.toBe(true);
    await expect(
      linearWorkflowRouterAction.validate(runtime, createMessage("Show Linear activity"))
    ).resolves.toBe(true);
  });
});
