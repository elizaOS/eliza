import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { GitHubOctokitClient } from "../types.js";
import { issueOpAction } from "./issue-op.js";
import { notificationTriageAction } from "./notification-triage.js";
import { prOpAction } from "./pr-op.js";

function createRuntime(octokit: GitHubOctokitClient): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return {
    agentId: "00000000-0000-0000-0000-00000000agent",
    getService: () => ({ getOctokit: () => octokit }),
    getCache: async (key: string) => cache.get(key),
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    },
    deleteCache: async (key: string) => cache.delete(key),
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  } as unknown as IAgentRuntime;
}

function userTurn(text: string): Memory {
  return {
    entityId: "00000000-0000-0000-0000-00000000user",
    content: { text },
  } as unknown as Memory;
}

describe("GitHub subaction and options resolution", () => {
  it("resolves GITHUB_PR_OP with subaction parameter at root", async () => {
    const pullsList = vi.fn().mockResolvedValue({
      data: [
        {
          number: 1,
          title: "PR 1",
          state: "open",
          html_url: "https://github.test/org/repo/pull/1",
          user: { login: "alice" },
        },
      ],
    });
    const runtime = createRuntime({
      pulls: { list: pullsList },
    } as unknown as GitHubOctokitClient);

    const result = await prOpAction.handler(
      runtime,
      userTurn("list PRs"),
      undefined,
      { subaction: "list", repo: "org/repo" },
    );

    expect(result.success).toBe(true);
    if (result.success && "prs" in result.data) {
      expect(result.data.prs).toHaveLength(1);
      expect(result.data.prs[0].number).toBe(1);
    } else {
      throw new Error("expected PR list result");
    }
  });

  it("resolves GITHUB_PR_OP when parameters are wrapped in HandlerOptions.parameters", async () => {
    const pullsList = vi.fn().mockResolvedValue({ data: [] });
    const runtime = createRuntime({
      pulls: { list: pullsList },
    } as unknown as GitHubOctokitClient);

    const result = await prOpAction.handler(
      runtime,
      userTurn("list PRs"),
      undefined,
      {
        parameters: {
          subaction: "list",
          repo: "org/repo",
          state: "all",
        },
      },
    );

    expect(result.success).toBe(true);
    expect(pullsList).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "org",
        repo: "repo",
        state: "all",
      }),
    );
  });

  it("accepts snake_case review_action and whitespace-padded subaction in GITHUB_PR_OP", async () => {
    const runtime = createRuntime({
      pulls: {},
    } as unknown as GitHubOctokitClient);

    const prompts: string[] = [];
    const callback = async (content: { text?: string }) => {
      prompts.push(content.text ?? "");
      return [];
    };

    const result = await prOpAction.handler(
      runtime,
      userTurn("review PR"),
      undefined,
      {
        parameters: {
          subaction: " review ",
          repo: "org/repo",
          number: 42,
          review_action: "request_changes",
          body: "Please add tests.",
        },
      },
      callback,
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ requiresConfirmation: true });
    expect(prompts.at(-1)).toContain("About to request changes PR org/repo#42");
    expect(prompts.at(-1)).toContain("Please add tests.");
  });

  it("resolves GITHUB_ISSUE_OP with subaction parameter at root", async () => {
    const runtime = createRuntime({
      issues: {},
    } as unknown as GitHubOctokitClient);

    const prompts: string[] = [];
    const callback = async (content: { text?: string }) => {
      prompts.push(content.text ?? "");
      return [];
    };

    const result = await issueOpAction.handler(
      runtime,
      userTurn("close issue"),
      undefined,
      {
        subaction: "close",
        repo: "org/repo",
        number: 10,
      },
      callback,
    );

    expect(result.success).toBe(false);
    expect(result.requiresConfirmation).toBe(true);
    expect(prompts.at(-1)).toContain("About to close org/repo#10");
  });

  it("resolves GITHUB_ISSUE_OP with parameters wrapped in options.parameters", async () => {
    const runtime = createRuntime({
      issues: {},
    } as unknown as GitHubOctokitClient);

    const prompts: string[] = [];
    const callback = async (content: { text?: string }) => {
      prompts.push(content.text ?? "");
      return [];
    };

    const result = await issueOpAction.handler(
      runtime,
      userTurn("comment on issue"),
      undefined,
      {
        parameters: {
          subaction: "comment",
          repo: "org/repo",
          number: 55,
          body: "Fix verified.",
        },
      },
      callback,
    );

    expect(result.success).toBe(false);
    expect(result.requiresConfirmation).toBe(true);
    expect(prompts.at(-1)).toContain(
      'About to comment on org/repo#55 body: "Fix verified."',
    );
  });

  it("unwraps options.parameters in GITHUB_NOTIFICATION_TRIAGE", async () => {
    const listNotifications = vi.fn().mockResolvedValue({ data: [] });
    const runtime = createRuntime({
      activity: { listNotificationsForAuthenticatedUser: listNotifications },
    } as unknown as GitHubOctokitClient);

    const result = await notificationTriageAction.handler(
      runtime,
      userTurn("triage notifications"),
      undefined,
      {
        parameters: {
          as: "user",
        },
      },
    );

    expect(result.success).toBe(true);
    expect(listNotifications).toHaveBeenCalled();
  });
});
