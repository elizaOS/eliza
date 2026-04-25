import type { ActionResult, Memory } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { gmailAction } from "../src/actions/gmail.js";
import { inboxAction } from "../src/actions/inbox.js";
import { ownerInboxAction } from "../src/actions/owner-inbox.js";
import { searchAcrossChannelsAction } from "../src/actions/search-across-channels.js";

function message(text: string): Memory {
  return {
    id: "m1",
    roomId: "r1",
    entityId: "u1",
    content: { text, source: "test" },
  } as Memory;
}

function ok(text: string): ActionResult {
  return { text, success: true };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OWNER_INBOX routing", () => {
  it("infers gmail for needs_response when channel is omitted", async () => {
    const gmailSpy = vi
      .spyOn(gmailAction, "handler")
      .mockResolvedValue(ok("gmail needs_response"));
    const inboxSpy = vi
      .spyOn(inboxAction, "handler")
      .mockResolvedValue(ok("inbox digest"));

    const result = await ownerInboxAction.handler!(
      { useModel: vi.fn() } as never,
      message("which emails need a response"),
      undefined,
      {
        parameters: {
          subaction: "needs_response",
          intent: "which emails need a response",
        },
      },
    );

    expect(result.success).toBe(true);
    expect(gmailSpy).toHaveBeenCalledTimes(1);
    expect(inboxSpy).not.toHaveBeenCalled();
    expect(gmailSpy.mock.calls[0]?.[3]).toMatchObject({
      parameters: { subaction: "needs_response" },
    });
  });

  it("infers gmail search from structured gmail filters when channel is omitted", async () => {
    const gmailSpy = vi
      .spyOn(gmailAction, "handler")
      .mockResolvedValue(ok("gmail search"));
    const searchSpy = vi
      .spyOn(searchAcrossChannelsAction, "handler")
      .mockResolvedValue(ok("cross-channel search"));

    const result = await ownerInboxAction.handler!(
      { useModel: vi.fn() } as never,
      message("find the finance email about the q3 budget"),
      undefined,
      {
        parameters: {
          subaction: "search",
          senderQuery: "finance",
          subjectQuery: "q3 budget",
        },
      },
    );

    expect(result.success).toBe(true);
    expect(gmailSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy).not.toHaveBeenCalled();
    expect(gmailSpy.mock.calls[0]?.[3]).toMatchObject({
      parameters: {
        subaction: "search",
        query: "from:finance subject:q3 budget",
        queries: ["from:finance subject:q3 budget"],
      },
    });
  });

  it("defaults planner-selected gmail-only work to channel=gmail", async () => {
    const gmailSpy = vi
      .spyOn(gmailAction, "handler")
      .mockResolvedValue(ok("gmail needs_response"));
    const inboxSpy = vi
      .spyOn(inboxAction, "handler")
      .mockResolvedValue(ok("inbox digest"));

    const runtime = {
      useModel: vi.fn().mockResolvedValue(
        JSON.stringify({
          subaction: "needs_response",
          channel: null,
          shouldAct: true,
          response: null,
        }),
      ),
      getMemories: vi.fn().mockResolvedValue([]),
      logger: { warn: vi.fn() },
    };

    const result = await ownerInboxAction.handler!(
      runtime as never,
      message("respond to the emails that need an answer"),
      undefined,
      {
        parameters: {
          intent: "respond to the emails that need an answer",
        },
      },
    );

    expect(result.success).toBe(true);
    expect(runtime.useModel).toHaveBeenCalledTimes(1);
    expect(gmailSpy).toHaveBeenCalledTimes(1);
    expect(inboxSpy).not.toHaveBeenCalled();
    expect(gmailSpy.mock.calls[0]?.[3]).toMatchObject({
      parameters: { subaction: "needs_response" },
    });
  });
});
