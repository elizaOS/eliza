import type { HandlerCallback, IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { manageIssuesAction } from "../actions/manage-issues.js";
import type { AuthPromptCallback } from "../services/workspace-github.js";

function createMemory(): Memory {
  return {
    entityId: "agent-1" as Memory["entityId"],
    agentId: "agent-1" as Memory["agentId"],
    roomId: "room-1" as Memory["roomId"],
    content: {
      text: "list issues in owner/repo",
      operation: "list",
      repo: "owner/repo",
    },
  } as Memory;
}

describe("MANAGE_ISSUES OAuth prompt delivery", () => {
  it("uses the coordinator chat bridge instead of the buffered action callback", async () => {
    let authPromptCallback: AuthPromptCallback | null = null;
    const sendChatMessage = vi.fn(() => true);
    const actionCallback = vi.fn(async () => []) satisfies HandlerCallback;
    const workspaceService = {
      setAuthPromptCallback(callback: AuthPromptCallback) {
        authPromptCallback = callback;
      },
      async listIssues() {
        expect(authPromptCallback).not.toBeNull();
        const delivered = await authPromptCallback?.({
          verificationUri: "https://github.com/login/device",
          userCode: "ABCD-EFGH",
          expiresIn: 600,
        });
        expect(delivered).toBe(true);
        return [];
      },
    };
    const runtime = {
      agentId: "agent-1",
      getService(name: string) {
        if (name === "CODING_WORKSPACE_SERVICE") return workspaceService;
        if (name === "PTY_SERVICE") return { coordinator: { sendChatMessage } };
        return null;
      },
    } as unknown as IAgentRuntime;

    const result = await manageIssuesAction.handler(
      runtime,
      createMemory(),
      undefined,
      { parameters: { operation: "list", repo: "owner/repo" } },
      actionCallback,
    );

    expect(result?.success).toBe(true);
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
    expect(sendChatMessage.mock.calls[0]?.[0]).toContain("ABCD-EFGH");
    expect(sendChatMessage.mock.calls[0]?.[1]).toBe("github-auth");
    expect(actionCallback).toHaveBeenCalledTimes(1);
    expect(actionCallback.mock.calls[0]?.[0]?.text).toContain(
      "No open issues found",
    );
  });
});
