/**
 * Pins the X DM inbox read to the inbound direction before its limit: the
 * LifeOps DM cache also stores the account's own outbound DMs, so a limited
 * read that filters direction afterwards loses inbound DMs behind newer
 * replies. Deterministic stub source that applies limit like the repository.
 */
import type { LifeOpsXConnectorStatus, LifeOpsXDm } from "@elizaos/contracts";
import { describe, expect, it } from "vitest";
import { fetchXDmMessages, type XDmInboxSource } from "./message-fetcher";

function dm(
  externalDmId: string,
  isInbound: boolean,
  minute: number,
): LifeOpsXDm {
  return {
    id: externalDmId,
    agentId: "agent",
    externalDmId,
    conversationId: "conv-1",
    senderHandle: isInbound ? "friend" : "owner",
    senderId: isInbound ? "friend-id" : "owner-id",
    isInbound,
    text: externalDmId,
    receivedAt: `2026-07-11T07:${String(minute).padStart(2, "0")}:00.000Z`,
    readAt: null,
    repliedAt: null,
    metadata: {},
    syncedAt: "2026-07-11T08:00:00.000Z",
    updatedAt: "2026-07-11T08:00:00.000Z",
  } as LifeOpsXDm;
}

describe("fetchXDmMessages", () => {
  it("reads inbound DMs past newer outbound replies", async () => {
    const cached = [
      dm("reply-3", false, 30),
      dm("reply-2", false, 20),
      dm("reply-1", false, 15),
      dm("question-2", true, 10),
      dm("question-1", true, 5),
    ];
    const source: XDmInboxSource = {
      getXConnectorStatus: async () =>
        ({ connected: true, dmRead: true }) as LifeOpsXConnectorStatus,
      syncXDms: async () => ({ synced: 0 }),
      getXDms: async (opts) => {
        const rows =
          opts?.inbound === undefined
            ? cached
            : cached.filter((row) => row.isInbound === opts.inbound);
        return opts?.limit === undefined ? rows : rows.slice(0, opts.limit);
      },
    };

    const result = await fetchXDmMessages(source, { limit: 2 });

    expect(result.messages.map((message) => message.text)).toEqual([
      "question-2",
      "question-1",
    ]);
  });
});
