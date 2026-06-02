import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { XDmAdapter } from "./lifeops-message-adapter.js";

function runtimeWithXService(service: unknown): IAgentRuntime {
  return {
    agentId: "agent-1",
    getService: vi.fn((serviceType: string) =>
      serviceType === "x" ? service : null,
    ),
  } as unknown as IAgentRuntime;
}

describe("XDmAdapter", () => {
  it("maps plugin-x direct-message memories into message refs", async () => {
    const memory: Memory = {
      id: "memory-1",
      agentId: "agent-1",
      entityId: "entity-1",
      roomId: "room-1",
      createdAt: Date.parse("2026-05-08T00:00:00.000Z"),
      content: { text: "hello from x" },
      metadata: {
        messageIdFull: "native-1",
        sender: { id: "sender-1", username: "alice" },
        x: {
          dmEventId: "dm-1",
          conversationId: "conversation-1",
          senderId: "x-user-1",
          senderUsername: "alice_x",
        },
      },
    } as Memory;
    const fetchDirectMessagesForAccount = vi.fn(async () => [memory]);
    const adapter = new XDmAdapter();
    const runtime = runtimeWithXService({ fetchDirectMessagesForAccount });

    const refs = await adapter.listMessages(runtime, { limit: 5 });

    expect(fetchDirectMessagesForAccount).toHaveBeenCalledWith("default", {
      participantId: undefined,
      limit: 5,
    });
    expect(refs).toMatchObject([
      {
        id: "twitter:dm-1",
        source: "twitter",
        externalId: "dm-1",
        threadId: "conversation-1",
        channelId: "conversation-1",
        from: { identifier: "x-user-1", displayName: "alice_x" },
        body: "hello from x",
      },
    ]);
  });

  it("creates and sends direct-message drafts through plugin-x", async () => {
    const sendDirectMessageForAccount = vi.fn(async () => ({
      ok: true,
      status: 201,
      messageId: "sent-1",
    }));
    const adapter = new XDmAdapter();
    const runtime = runtimeWithXService({ sendDirectMessageForAccount });

    const draft = await adapter.createDraft(runtime, {
      to: [{ identifier: "recipient-1" }],
      body: "see you tomorrow",
    });
    const sent = await adapter.sendDraft(runtime, draft.draftId);

    expect(sendDirectMessageForAccount).toHaveBeenCalledWith("default", {
      participantId: "recipient-1",
      text: "see you tomorrow",
    });
    expect(sent).toEqual({ externalId: "sent-1" });
  });

  it("rejects empty direct-message drafts before encoding them", async () => {
    const sendDirectMessageForAccount = vi.fn();
    const adapter = new XDmAdapter();
    const runtime = runtimeWithXService({ sendDirectMessageForAccount });

    await expect(
      adapter.createDraft(runtime, {
        to: [{ identifier: "recipient-1" }],
        body: " \n\t ",
      }),
    ).rejects.toThrow("requires non-empty body");

    expect(sendDirectMessageForAccount).not.toHaveBeenCalled();
  });

  it("surfaces failed direct-message sends instead of synthesizing success", async () => {
    const sendDirectMessageForAccount = vi.fn(async () => ({
      ok: false,
      status: 403,
      messageId: null,
    }));
    const adapter = new XDmAdapter();
    const runtime = runtimeWithXService({ sendDirectMessageForAccount });

    const draft = await adapter.createDraft(runtime, {
      to: [{ identifier: "recipient-1" }],
      body: "blocked message",
    });

    await expect(adapter.sendDraft(runtime, draft.draftId)).rejects.toThrow(
      "status 403",
    );
  });

  it("normalizes malformed memories and hostile list limits without throwing", async () => {
    const memory = {
      id: "memory-2",
      agentId: "agent-1",
      entityId: "entity-2",
      roomId: "room-2",
      createdAt: "not-a-date",
      content: null,
      metadata: {
        x: {
          dmEventId: "",
          senderId: "",
          conversationId: "",
        },
      },
    } as unknown as Memory;
    const fetchDirectMessagesForAccount = vi.fn(async () => [memory]);
    const adapter = new XDmAdapter();
    const runtime = runtimeWithXService({ fetchDirectMessagesForAccount });

    const refs = await adapter.listMessages(runtime, {
      limit: Number.POSITIVE_INFINITY,
    });

    expect(fetchDirectMessagesForAccount).toHaveBeenCalledWith("default", {
      participantId: undefined,
      limit: 25,
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      id: "twitter:memory-2",
      externalId: "memory-2",
      threadId: "room-2",
      from: { identifier: "entity-2", displayName: "" },
      body: "",
      snippet: "",
    });
    expect(Number.isFinite(refs[0]?.receivedAtMs)).toBe(true);
  });

  it("clamps low and high list limits before calling the X service", async () => {
    const fetchDirectMessagesForAccount = vi.fn(async () => []);
    const adapter = new XDmAdapter();
    const runtime = runtimeWithXService({ fetchDirectMessagesForAccount });

    await adapter.listMessages(runtime, { limit: -50 });
    await adapter.listMessages(runtime, { limit: 10_000 });

    expect(fetchDirectMessagesForAccount).toHaveBeenNthCalledWith(
      1,
      "default",
      {
        participantId: undefined,
        limit: 1,
      },
    );
    expect(fetchDirectMessagesForAccount).toHaveBeenNthCalledWith(
      2,
      "default",
      {
        participantId: undefined,
        limit: 100,
      },
    );
  });

  it("rejects malformed draft ids before sending", async () => {
    const sendDirectMessageForAccount = vi.fn();
    const adapter = new XDmAdapter();
    const runtime = runtimeWithXService({ sendDirectMessageForAccount });

    await expect(
      adapter.sendDraft(runtime, "telegram:recipient:1:SGk"),
    ).rejects.toThrow("[XDmAdapter] malformed draftId");
    await expect(
      adapter.sendDraft(runtime, "twitter:recipient:SGk"),
    ).rejects.toThrow("[XDmAdapter] malformed draftId");
    await expect(adapter.sendDraft(runtime, "twitter::1:SGk")).rejects.toThrow(
      "cannot resolve recipient",
    );

    expect(sendDirectMessageForAccount).not.toHaveBeenCalled();
  });
});
