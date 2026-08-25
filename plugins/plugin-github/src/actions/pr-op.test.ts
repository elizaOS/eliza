/**
 * Verifies GITHUB_PR_OP action validation, confirmation gating, and review execution.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import { prOpAction } from "./pr-op.js";

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
    content: { text: "review pr" },
  } as unknown as Memory;
}

describe("GITHUB_PR_OP review validation", () => {
  it("rejects request-changes without a body before initiating confirmation", async () => {
    const runtime = makeRuntime();
    const message = makeMessage();
    const callback = vi.fn();

    const result = await prOpAction.handler(
      runtime,
      message,
      undefined,
      {
        op: "review",
        repo: "owner/repo",
        number: 42,
        action: "request-changes",
      },
      callback,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "request-changes review requires a body explaining the changes",
    );
    expect(callback).toHaveBeenCalledWith({
      text: "request-changes review requires a body explaining the changes",
    });
  });

  it("rejects invalid repo format before initiating confirmation", async () => {
    const runtime = makeRuntime();
    const message = makeMessage();
    const callback = vi.fn();

    const result = await prOpAction.handler(
      runtime,
      message,
      undefined,
      {
        op: "review",
        repo: "invalid-repo",
        number: 42,
        action: "approve",
      },
      callback,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid repo "invalid-repo"');
  });

  it("rejects missing parameters before initiating confirmation", async () => {
    const runtime = makeRuntime();
    const message = makeMessage();
    const callback = vi.fn();

    const result = await prOpAction.handler(
      runtime,
      message,
      undefined,
      {
        op: "review",
        repo: "owner/repo",
      },
      callback,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("GITHUB_PR_OP review requires repo");
  });
});
