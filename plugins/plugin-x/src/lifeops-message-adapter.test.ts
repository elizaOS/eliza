/** Unit tests for `XDmAdapter`: mapping DM memories to message refs, drafting/sending through plugin-x, rejecting empty drafts, and surfacing send failures rather than faking success; mocked XService. */
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
  it("searches beyond the default DM listing window before applying its result limit", async () => {
    const stored = Array.from(
      { length: 151 },
      (_, index) =>
        ({
          id: `memory-${index}`,
          agentId: "agent-1",
          entityId: "sender-1",
          roomId: "room-1",
          createdAt: 1000 - index,
          content: { text: index >= 149 ? "invoice attached" : "unrelated" },
          metadata: {
            x: {
              dmEventId: `dm-${index}`,
              senderId: "sender-1",
              conversationId: "thread-1",
            },
          },
        }) as Memory,
    );
    const fetchDirectMessagesForAccount = vi.fn(
      async (_account: string, options: { limit?: number }) =>
        options.limit === undefined ? stored : stored.slice(0, options.limit),
    );
    const adapter = new XDmAdapter();
    const runtime = runtimeWithXService({ fetchDirectMessagesForAccount });
    const hits = await adapter.searchMessages(runtime, {
      content: "invoice",
      limit: 1,
    });
    expect(hits.map((hit) => hit.id)).toEqual(["twitter:dm-149"]);
    expect(fetchDirectMessagesForAccount).toHaveBeenCalledWith("default", {
      participantId: undefined,
      limit: undefined,
    });
  });

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

  it("preserves the complete long direct-message draft preview", async () => {
    const adapter = new XDmAdapter();
    const runtime = runtimeWithXService({});
    const body = `${"x".repeat(200)}🦊${"y".repeat(500)}tail`;

    const draft = await adapter.createDraft(runtime, {
      to: [{ identifier: "recipient-1" }],
      body,
    });

    expect(draft.preview).toBe(body);
    expect(draft.preview.isWellFormed()).toBe(true);
    expect(draft.preview.endsWith("tail")).toBe(true);
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

  it("normalizes malformed memories without imposing a listing limit", async () => {
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
      limit: undefined,
    });

    expect(fetchDirectMessagesForAccount).toHaveBeenCalledWith("default", {
      participantId: undefined,
      limit: undefined,
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

  it("preserves explicit limits and rejects invalid limits before fetching", async () => {
    const fetchDirectMessagesForAccount = vi.fn(async () => []);
    const adapter = new XDmAdapter();
    const runtime = runtimeWithXService({ fetchDirectMessagesForAccount });
    for (const limit of [-50, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(adapter.listMessages(runtime, { limit })).rejects.toThrow(
        "positive safe integer",
      );
    }
    expect(fetchDirectMessagesForAccount).not.toHaveBeenCalled();
    await adapter.listMessages(runtime, { limit: 10_000 });
    expect(fetchDirectMessagesForAccount).toHaveBeenCalledWith("default", {
      participantId: undefined,
      limit: 10_000,
    });
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
