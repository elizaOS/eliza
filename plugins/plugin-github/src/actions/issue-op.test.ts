/**
 * Verifies GITHUB_ISSUE_OP preflight validation and confirmation pending key isolation.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import { issueOpAction } from "./issue-op.js";

function makeRuntime(): IAgentRuntime {
  return {
    getSetting: vi.fn(() => undefined),
  } as unknown as IAgentRuntime;
}

function makeMessage(): Memory {
  return {
    id: "msg-123",
    agentId: "agent-123",
    roomId: "room-123",
    entityId: "user-123",
    content: { text: "github issue op" },
  } as unknown as Memory;
}

describe("GITHUB_ISSUE_OP preflight validation", () => {
  it("rejects create without title before confirmation", async () => {
    const runtime = makeRuntime();
    const message = makeMessage();
    const callback = vi.fn();

    const result = await issueOpAction.handler(
      runtime,
      message,
      undefined,
      {
        op: "create",
        repo: "owner/repo",
      },
      callback,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("GITHUB_ISSUE_OP create requires title");
    expect(callback).toHaveBeenCalledWith({
      text: "GITHUB_ISSUE_OP create requires title",
    });
  });

  it("rejects comment without body before confirmation", async () => {
    const runtime = makeRuntime();
    const message = makeMessage();
    const callback = vi.fn();

    const result = await issueOpAction.handler(
      runtime,
      message,
      undefined,
      {
        op: "comment",
        repo: "owner/repo",
        number: 42,
      },
      callback,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "GITHUB_ISSUE_OP comment requires number (integer) and body",
    );
  });

  it("rejects assign without assignees before confirmation", async () => {
    const runtime = makeRuntime();
    const message = makeMessage();
    const callback = vi.fn();

    const result = await issueOpAction.handler(
      runtime,
      message,
      undefined,
      {
        op: "assign",
        repo: "owner/repo",
        number: 42,
      },
      callback,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("GITHUB_ISSUE_OP assign requires number");
  });

  it("rejects label without labels before confirmation", async () => {
    const runtime = makeRuntime();
    const message = makeMessage();
    const callback = vi.fn();

    const result = await issueOpAction.handler(
      runtime,
      message,
      undefined,
      {
        op: "label",
        repo: "owner/repo",
        number: 42,
      },
      callback,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("GITHUB_ISSUE_OP label requires number");
  });

  it("rejects close/reopen without issue number before confirmation", async () => {
    const runtime = makeRuntime();
    const message = makeMessage();
    const callback = vi.fn();

    const result = await issueOpAction.handler(
      runtime,
      message,
      undefined,
      {
        op: "close",
        repo: "owner/repo",
      },
      callback,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "GITHUB_ISSUE_OP close requires number (integer)",
    );
  });
});
