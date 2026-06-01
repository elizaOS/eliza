import type { IAgentRuntime, Memory } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createIssueAction } from "./createIssue";

function message(text?: string): Memory {
  return {
    id: "msg",
    agentId: "agent",
    entityId: "entity",
    roomId: "room",
    content: { text, source: "test" },
  } as Memory;
}

function runtime(service: Record<string, unknown>, modelResponse?: string): IAgentRuntime {
  return {
    getService: vi.fn((name: string) => (name === "linear" ? service : undefined)),
    getSetting: vi.fn((key: string) =>
      key === "LINEAR_DEFAULT_TEAM_KEY" ? "ENG" : undefined,
    ),
    useModel: vi.fn(async (modelType) => {
      expect(modelType).toBe(ModelType.TEXT_LARGE);
      return modelResponse ?? "{}";
    }),
  } as unknown as IAgentRuntime;
}

describe("createIssueAction", () => {
  it("returns a useful validation message when issue text is missing", async () => {
    const callback = vi.fn();
    const result = await createIssueAction.handler(
      runtime({}),
      message(undefined),
      "default",
      "default",
      callback,
    );

    expect(result).toEqual({
      text: "Please provide a description for the issue.",
      success: false,
    });
    expect(callback).toHaveBeenCalledWith({
      text: "Please provide a description for the issue.",
      source: "test",
    });
  });

  it("creates an issue from structured parameters without calling the LLM", async () => {
    const service = {
      createIssue: vi.fn(async (input) => ({
        id: "issue-id",
        title: input.title,
        identifier: "ENG-42",
        url: "https://linear.app/acme/issue/ENG-42",
      })),
      getDefaultTeamKey: vi.fn(() => "ENG"),
      getTeams: vi.fn(async () => [{ id: "team-id", key: "ENG", name: "Engineering" }]),
    };
    const rt = runtime(service);
    const callback = vi.fn();

    const result = await createIssueAction.handler(
      rt,
      message("Create a bug"),
      "default",
      {
        parameters: {
          issueData: {
            title: "Fix login",
            description: "Login fails on mobile",
            teamId: "team-id",
            priority: 2,
          },
        },
      },
      callback,
    );

    expect(rt.useModel).not.toHaveBeenCalled();
    expect(service.createIssue).toHaveBeenCalledWith(
      {
        title: "Fix login",
        description: "Login fails on mobile",
        teamId: "team-id",
        priority: 2,
      },
      "default",
    );
    expect(result).toMatchObject({
      success: true,
      text: "Created issue: Fix login (ENG-42)",
      data: {
        issueId: "issue-id",
        identifier: "ENG-42",
        url: "https://linear.app/acme/issue/ENG-42",
      },
    });
    expect(callback).toHaveBeenCalledWith({
      text: expect.stringContaining("Created Linear issue: Fix login (ENG-42)"),
      source: "test",
    });
  });

  it("falls back to user text and default team when model JSON is malformed", async () => {
    const service = {
      createIssue: vi.fn(async (input) => ({
        id: "issue-id",
        title: input.title,
        identifier: "ENG-7",
        url: "https://linear.app/acme/issue/ENG-7",
      })),
      getDefaultTeamKey: vi.fn(() => "ENG"),
      getTeams: vi.fn(async () => [{ id: "team-id", key: "ENG", name: "Engineering" }]),
    };

    const result = await createIssueAction.handler(
      runtime(service, "not json at all"),
      message("Investigate a flaky deploy failure"),
      "default",
      undefined,
      vi.fn(),
    );

    expect(service.createIssue).toHaveBeenCalledWith(
      {
        title: "Investigate a flaky deploy failure",
        description: "Investigate a flaky deploy failure",
        teamId: "team-id",
      },
      "default",
    );
    expect(result.success).toBe(true);
  });

  it("reports no-team and create failures through callback and result text", async () => {
    const noTeamService = {
      getDefaultTeamKey: vi.fn(() => undefined),
      getTeams: vi.fn(async () => []),
      createIssue: vi.fn(),
    };
    const noTeamCallback = vi.fn();
    const noTeam = await createIssueAction.handler(
      runtime(noTeamService, '{"title":"No team"}'),
      message("Create no-team issue"),
      undefined,
      undefined,
      noTeamCallback,
    );
    expect(noTeam).toMatchObject({
      success: false,
      text: "No Linear teams found. Please ensure at least one team exists in your Linear workspace.",
    });
    expect(noTeamService.createIssue).not.toHaveBeenCalled();

    const failingService = {
      getDefaultTeamKey: vi.fn(() => undefined),
      getTeams: vi.fn(async () => [{ id: "team-id", key: "ENG", name: "Engineering" }]),
      createIssue: vi.fn(async () => {
        throw new Error("Linear API rate limited");
      }),
    };
    const failed = await createIssueAction.handler(
      runtime(failingService, '{"title":"Rate limit"}'),
      message("Create rate-limit issue"),
      undefined,
      undefined,
      vi.fn(),
    );
    expect(failed).toMatchObject({
      success: false,
      text: "❌ Failed to create issue: Linear API rate limited",
    });
  });
});
