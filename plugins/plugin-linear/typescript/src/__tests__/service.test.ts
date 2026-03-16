import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LinearService } from "../services/linear";

vi.mock("@linear/sdk", () => {
  class MockLinearClient {
    viewer = Promise.resolve({
      id: "user-123",
      email: "test@example.com",
      name: "Test User",
    });

    teams = vi.fn().mockResolvedValue({
      nodes: [
        {
          id: "team-123",
          name: "Engineering",
          key: "ENG",
          description: "Engineering team",
        },
      ],
    });

    createIssue = vi.fn().mockResolvedValue({
      issue: Promise.resolve({
        id: "issue-123",
        identifier: "ENG-123",
        title: "Test Issue",
        url: "https://linear.app/test/issue/ENG-123",
      }),
    });
  }

  return {
    LinearClient: MockLinearClient,
  };
});

describe("LinearService", () => {
  let agentRuntime: IAgentRuntime;
  let service: LinearService;

  beforeEach(() => {
    agentRuntime = {
      getSetting: vi.fn((key: string) => {
        if (key === "LINEAR_API_KEY") return "test-api-key";
        if (key === "LINEAR_WORKSPACE_ID") return "test-workspace";
        return undefined;
      }),
    } as Partial<IAgentRuntime> as IAgentRuntime;
  });

  it("should initialize successfully with valid API key", async () => {
    service = await LinearService.start(agentRuntime);
    expect(service).toBeInstanceOf(LinearService);
  });

  it("should throw error without API key", async () => {
    agentRuntime.getSetting = vi.fn().mockReturnValue(undefined);

    await expect(LinearService.start(agentRuntime)).rejects.toThrow("Linear API key is required");
  });

  it("should get teams", async () => {
    service = await LinearService.start(agentRuntime);
    const teams = await service.getTeams();

    expect(teams).toHaveLength(1);
    expect(teams[0]).toHaveProperty("name", "Engineering");
  });

  it("should create an issue", async () => {
    service = await LinearService.start(agentRuntime);

    const issue = await service.createIssue({
      title: "Test Issue",
      description: "Test description",
      teamId: "team-123",
      priority: 3,
    });

    expect(issue).toHaveProperty("identifier", "ENG-123");
    expect(issue).toHaveProperty("title", "Test Issue");
  });

  it("should track activity", async () => {
    service = await LinearService.start(agentRuntime);

    service.clearActivityLog();

    await service.createIssue({
      title: "Test Issue",
      teamId: "team-123",
    });

    const activity = service.getActivityLog();
    expect(activity).toHaveLength(1);
    expect(activity[0]).toHaveProperty("action", "create_issue");
    expect(activity[0]).toHaveProperty("success", true);
  });
});
