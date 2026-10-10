/**
 * An explicit X DM or merged-inbox limit of 0 is an empty page. The DM reader
 * ignored the limit after filtering, and the merged pull treated 0 as no page.
 */

import type { LifeOpsXDm } from "@elizaos/contracts";
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  fetchAllMessages,
  fetchXDmMessages,
  type XDmInboxSource,
} from "./message-fetcher";

function dm(id: string): LifeOpsXDm {
  return {
    id,
    agentId: "agent",
    externalDmId: id,
    conversationId: "conversation",
    senderHandle: "alice",
    senderId: "sender",
    isInbound: true,
    text: id,
    receivedAt: "2026-08-13T00:00:00.000Z",
    readAt: null,
    repliedAt: null,
    metadata: {},
    syncedAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  };
}

function source(): XDmInboxSource {
  return {
    getXConnectorStatus: async () =>
      ({
        connected: true,
        dmRead: true,
      }) as Awaited<ReturnType<XDmInboxSource["getXConnectorStatus"]>>,
    syncXDms: async () => ({ synced: 2 }),
    getXDms: async () => [dm("first"), dm("second")],
  };
}

describe("inbox X DM explicit empty page", () => {
  it("treats an X DM limit of 0 as an empty page", async () => {
    const empty = await fetchXDmMessages(source(), { limit: 0 });
    expect(empty.messages).toEqual([]);

    const one = await fetchXDmMessages(source(), { limit: 1 });
    expect(one.messages.map((message) => message.id)).toEqual(["first"]);

    const all = await fetchXDmMessages(source(), {});
    expect(all.messages.map((message) => message.id)).toEqual([
      "first",
      "second",
    ]);
  });

  it("treats a merged inbox limit of 0 as an empty page", async () => {
    const empty = await fetchAllMessages({} as IAgentRuntime, {
      sources: ["x_dm"],
      xDmSource: source(),
      limit: 0,
    });
    expect(empty.messages).toEqual([]);

    const one = await fetchAllMessages({} as IAgentRuntime, {
      sources: ["x_dm"],
      xDmSource: source(),
      limit: 1,
    });
    expect(one.messages.map((message) => message.id)).toEqual(["first"]);
  });
});
