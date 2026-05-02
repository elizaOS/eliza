import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { readUnreadXDmsAction } from "../actions/readUnreadXDms.js";
import { replyXDmAction } from "../actions/replyXDm.js";
import { sendXPostAction } from "../actions/sendXPost.js";
import { X_FEED_ADAPTER_SERVICE_TYPE } from "../actions/x-feed-adapter.js";
import type { XDirectMessage, XFeedTweet } from "../actions/x-feed-helpers.js";

function baseAdapter() {
  const sent: Array<{ kind: string; payload: unknown }> = [];
  const adapter = {
    sent,
    fetchHomeTimeline: async (): Promise<XFeedTweet[]> => [],
    searchRecent: async (): Promise<XFeedTweet[]> => [],
    listDirectMessages: async (): Promise<XDirectMessage[]> => [
      {
        id: "dm1",
        senderId: "u1",
        senderUsername: "jane_doe",
        text: "hey",
        createdAt: null,
        read: false,
      },
      {
        id: "dm2",
        senderId: "u2",
        senderUsername: "bob",
        text: "yo",
        createdAt: null,
        read: true,
      },
    ],
    sendDirectMessage: async (args: { recipient: string; text: string }) => {
      sent.push({ kind: "dm", payload: args });
      return { id: "dm-sent-1" };
    },
    createTweet: async (args: { text: string }) => {
      sent.push({ kind: "tweet", payload: args });
      return { id: "tweet-sent-1" };
    },
  };
  return adapter;
}

function runtimeFrom(adapter: ReturnType<typeof baseAdapter>): IAgentRuntime {
  return {
    getService: (type: string) =>
      type === X_FEED_ADAPTER_SERVICE_TYPE ? adapter : null,
    useModel: async () => "",
  } as unknown as IAgentRuntime;
}

describe("READ_UNREAD_X_DMS", () => {
  it("filters to unread messages only", async () => {
    const adapter = baseAdapter();
    const result = await readUnreadXDmsAction.handler(
      runtimeFrom(adapter),
      { content: { text: "any x dms" } } as unknown as Memory,
      undefined,
      {},
    );
    expect(result?.success).toBe(true);
    const data = result?.data as { messages: XDirectMessage[]; total: number };
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0]?.id).toBe("dm1");
    expect(data.total).toBe(2);
  });

  it("degrades gracefully when adapter absent", async () => {
    const runtime = {
      getService: () => null,
      useModel: async () => "",
    } as unknown as IAgentRuntime;
    const result = await readUnreadXDmsAction.handler(
      runtime,
      { content: { text: "any x dms" } } as unknown as Memory,
      undefined,
      {},
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { reason: string }).reason).toBe(
      "twitter-not-configured",
    );
  });

  it("surfaces rate-limit errors", async () => {
    const adapter = baseAdapter();
    adapter.listDirectMessages = async () => {
      throw Object.assign(new Error("429"), { code: 429 });
    };
    const result = await readUnreadXDmsAction.handler(
      runtimeFrom(adapter),
      { content: { text: "any x dms" } } as unknown as Memory,
      undefined,
      {},
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { reason: string }).reason).toBe("rate-limited");
  });
});

describe("REPLY_X_DM confirmation gate", () => {
  it("does NOT send without confirmed=true", async () => {
    const adapter = baseAdapter();
    const spy = vi.spyOn(adapter, "sendDirectMessage");
    const result = await replyXDmAction.handler(
      runtimeFrom(adapter),
      { content: { text: "reply" } } as unknown as Memory,
      undefined,
      { recipient: "jane_doe", text: "hello there" },
    );
    expect(spy).not.toHaveBeenCalled();
    expect(result?.success).toBe(false);
    const data = result?.data as {
      requiresConfirmation?: boolean;
      preview?: string;
      suppressActionResultClipboard?: boolean;
      suppressVisibleCallback?: boolean;
    };
    expect(data.requiresConfirmation).toBe(true);
    expect(data.preview).toContain("hello there");
    expect(data.suppressActionResultClipboard).not.toBe(true);
    expect(data.suppressVisibleCallback).not.toBe(true);
    expect(adapter.sent).toHaveLength(0);
  });

  it("sends when confirmed=true", async () => {
    const adapter = baseAdapter();
    const result = await replyXDmAction.handler(
      runtimeFrom(adapter),
      { content: { text: "reply" } } as unknown as Memory,
      undefined,
      { recipient: "jane_doe", text: "hello there", confirmed: true },
    );
    expect(result?.success).toBe(true);
    const data = result?.data as {
      dmId: string;
      recipient: string;
      suppressActionResultClipboard?: boolean;
      suppressVisibleCallback?: boolean;
    };
    expect(data.dmId).toBe("dm-sent-1");
    expect(data.recipient).toBe("jane_doe");
    expect(data.suppressActionResultClipboard).toBe(true);
    expect(data.suppressVisibleCallback).toBe(true);
    expect(adapter.sent).toEqual([
      { kind: "dm", payload: { recipient: "jane_doe", text: "hello there" } },
    ]);
  });

  it("fails with missing-parameters when recipient/text absent", async () => {
    const adapter = baseAdapter();
    const result = await replyXDmAction.handler(
      runtimeFrom(adapter),
      { content: { text: "reply" } } as unknown as Memory,
      undefined,
      { confirmed: true },
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { reason: string }).reason).toBe(
      "missing-parameters",
    );
    expect(adapter.sent).toHaveLength(0);
  });

  it("degrades gracefully when adapter absent", async () => {
    const runtime = {
      getService: () => null,
      useModel: async () => "",
    } as unknown as IAgentRuntime;
    const result = await replyXDmAction.handler(
      runtime,
      { content: { text: "reply" } } as unknown as Memory,
      undefined,
      { recipient: "j", text: "hi", confirmed: true },
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { reason: string }).reason).toBe(
      "twitter-not-configured",
    );
  });
});

describe("SEND_X_POST confirmation gate", () => {
  it("does NOT post without confirmed=true", async () => {
    const adapter = baseAdapter();
    const spy = vi.spyOn(adapter, "createTweet");
    const result = await sendXPostAction.handler(
      runtimeFrom(adapter),
      { content: { text: "post tweet" } } as unknown as Memory,
      undefined,
      { text: "shipped today" },
    );
    expect(spy).not.toHaveBeenCalled();
    expect(result?.success).toBe(false);
    expect(
      (result?.data as { requiresConfirmation?: boolean }).requiresConfirmation,
    ).toBe(true);
    expect(
      (result?.data as { suppressActionResultClipboard?: boolean })
        .suppressActionResultClipboard,
    ).not.toBe(true);
    expect(
      (result?.data as { suppressVisibleCallback?: boolean })
        .suppressVisibleCallback,
    ).not.toBe(true);
    expect(adapter.sent).toHaveLength(0);
  });

  it("posts when confirmed=true", async () => {
    const adapter = baseAdapter();
    const result = await sendXPostAction.handler(
      runtimeFrom(adapter),
      { content: { text: "post tweet" } } as unknown as Memory,
      undefined,
      { text: "shipped today", confirmed: true },
    );
    expect(result?.success).toBe(true);
    const data = result?.data as {
      tweetId: string;
      suppressActionResultClipboard?: boolean;
      suppressVisibleCallback?: boolean;
    };
    expect(data.tweetId).toBe("tweet-sent-1");
    expect(data.suppressActionResultClipboard).toBe(true);
    expect(data.suppressVisibleCallback).toBe(true);
    expect(adapter.sent).toEqual([
      { kind: "tweet", payload: { text: "shipped today" } },
    ]);
  });

  it("rejects tweets over 280 chars without sending", async () => {
    const adapter = baseAdapter();
    const long = "x".repeat(281);
    const result = await sendXPostAction.handler(
      runtimeFrom(adapter),
      { content: { text: "post tweet" } } as unknown as Memory,
      undefined,
      { text: long, confirmed: true },
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { reason: string }).reason).toBe("too-long");
    expect(adapter.sent).toHaveLength(0);
  });

  it("surfaces rate-limit when sending", async () => {
    const adapter = baseAdapter();
    adapter.createTweet = async () => {
      throw Object.assign(new Error("429"), { code: 429 });
    };
    const result = await sendXPostAction.handler(
      runtimeFrom(adapter),
      { content: { text: "post tweet" } } as unknown as Memory,
      undefined,
      { text: "x", confirmed: true },
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { reason: string }).reason).toBe("rate-limited");
  });
});
