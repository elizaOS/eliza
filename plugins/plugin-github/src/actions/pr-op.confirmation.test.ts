/** Verifies PR review confirmation is a single pending delivery, never a successful mutation receipt. */

import type { HandlerCallback, IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { prOpAction } from "./pr-op.js";

describe("GitHub PR review confirmation", () => {
  it("delivers one prompt and returns an explicit pending result", async () => {
    const callback = vi.fn<HandlerCallback>();
    const runtime = {
      getCache: vi.fn().mockResolvedValue(undefined),
      setCache: vi.fn().mockResolvedValue(undefined),
    } as unknown as IAgentRuntime;
    const message = {
      content: { source: "github", text: "approve this pull request" },
      entityId: "00000000-0000-0000-0000-000000000001",
      roomId: "00000000-0000-0000-0000-000000000002",
    } as Memory;

    const result = await prOpAction.handler(
      runtime,
      message,
      undefined,
      {
        op: "review",
        repo: "elizaOS/eliza",
        number: 42,
        action: "approve",
        body: "Looks good",
        as: "user",
      },
      callback,
    );

    const prompt =
      'About to approve PR elizaOS/eliza#42 with body: "Looks good" as user. Reply yes to confirm or no to cancel.';
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({ text: prompt, source: "github" });
    expect(result).toEqual({
      success: false,
      requiresConfirmation: true,
      preview:
        'About to approve PR elizaOS/eliza#42 with body: "Looks good" as user.',
      text: prompt,
      data: {
        requiresConfirmation: true,
        preview:
          'About to approve PR elizaOS/eliza#42 with body: "Looks good" as user.',
        awaitingUserInput: true,
      },
    });
  });
});
