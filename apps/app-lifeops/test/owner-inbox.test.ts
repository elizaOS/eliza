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
  it("routes gmail digest to gmail triage, not the unified inbox delegate", async () => {
    const gmailSpy = vi
      .spyOn(gmailAction, "handler")
      .mockResolvedValue(ok("gmail triage"));
    const inboxSpy = vi
      .spyOn(inboxAction, "handler")
      .mockResolvedValue(ok("inbox digest"));

    const result = await ownerInboxAction.handler!(
      { useModel: vi.fn() } as never,
      message("summarize my unread emails"),
      undefined,
      {
        parameters: {
          subaction: "digest",
          channel: "gmail",
          intent: "summarize unread email",
        },
      },
    );

    expect(result.success).toBe(true);
    expect(gmailSpy).toHaveBeenCalledTimes(1);
    expect(inboxSpy).not.toHaveBeenCalled();
    expect(gmailSpy.mock.calls[0]?.[3]).toMatchObject({
      parameters: { subaction: "triage" },
    });
  });

  it("routes gmail respond to gmail needs_response, not the cross-channel inbox delegate", async () => {
    const gmailSpy = vi
      .spyOn(gmailAction, "handler")
      .mockResolvedValue(ok("gmail respond"));
    const inboxSpy = vi
      .spyOn(inboxAction, "handler")
      .mockResolvedValue(ok("cross-channel respond"));

    const result = await ownerInboxAction.handler!(
      { useModel: vi.fn() } as never,
      message("respond to the emails that need an answer"),
      undefined,
      {
        parameters: {
          subaction: "respond",
          channel: "gmail",
          intent: "respond to emails that need an answer",
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

  it("uses the LLM sub-planner when subaction is missing and routes send-reply through OWNER_INBOX", async () => {
    const gmailSpy = vi
      .spyOn(gmailAction, "handler")
      .mockResolvedValue(ok("sent reply"));
    const searchSpy = vi
      .spyOn(searchAcrossChannelsAction, "handler")
      .mockResolvedValue(ok("search"));

    const runtime = {
      useModel: vi.fn().mockResolvedValue(
        JSON.stringify({
          subaction: "send_reply",
          channel: "gmail",
          shouldAct: true,
          response: null,
        }),
      ),
      getMemories: vi.fn().mockResolvedValue([]),
      logger: { warn: vi.fn() },
    };

    const result = await ownerInboxAction.handler!(
      runtime as never,
      message("send a reply to the last email from finance confirming receipt"),
      undefined,
      {
        parameters: {
          intent:
            "send a reply to the last email from finance confirming receipt",
        },
      },
    );

    expect(result.success).toBe(true);
    expect(runtime.useModel).toHaveBeenCalledTimes(1);
    expect(gmailSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy).not.toHaveBeenCalled();
    expect(gmailSpy.mock.calls[0]?.[3]).toMatchObject({
      parameters: { subaction: "send_reply" },
    });
  });
});

describe("INBOX standing policies", () => {
  it("records a group-chat handoff policy instead of requiring a live pending item", async () => {
    const result = await inboxAction.handler!(
      {} as never,
      message(
        "If direct relaying gets messy here, suggest making a group chat handoff instead.",
      ),
      undefined,
      {
        parameters: {
          subaction: "respond",
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain("group-chat handoff");
    expect(result.text).toContain("other people involved");
    expect(result.data).toMatchObject({
      actionName: "INBOX",
      subaction: "respond",
      policyRecorded: true,
      policyType: "group_chat_handoff",
    });
  });

  it("records a contextual bump policy instead of asking for a target item", async () => {
    const result = await inboxAction.handler!(
      {} as never,
      message(
        "If I still haven't answered about those three events, bump me again with context instead of starting over.",
      ),
      undefined,
      {
        parameters: {
          subaction: "respond",
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain("existing context attached");
    expect(result.data).toMatchObject({
      actionName: "INBOX",
      subaction: "respond",
      policyRecorded: true,
      policyType: "contextual_bump",
    });
  });
});
