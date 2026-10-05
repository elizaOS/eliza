/**
 * Pins the X DM inbox read to the inbound direction before its limit: the
 * LifeOps DM cache also stores the account's own outbound DMs, so a limited
 * read that filters direction afterwards loses inbound DMs behind newer
 * replies, and a limit-sized sync never caches the inbound rows at all.
 * Deterministic stub source that applies limit like the repository and slices
 * mixed-direction fetches like the X connector.
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

  it("widens the sync window so owner replies cannot crowd inbound DMs out of the cache", async () => {
    // Mirrors the connector contract: the newest mixed-direction rows exist,
    // but the fetch slices to the sync limit before anything is cached, and
    // the read filters direction before its limit (like listXDms).
    const newestMixed = [
      dm("reply-6", false, 36),
      dm("reply-5", false, 35),
      dm("reply-4", false, 34),
      dm("reply-3", false, 33),
      dm("reply-2", false, 32),
      dm("reply-1", false, 31),
      dm("question-3", true, 13),
      dm("question-2", true, 12),
      dm("question-1", true, 11),
    ];
    const cache: LifeOpsXDm[] = [];
    const syncCalls: Array<{ limit?: number }> = [];
    const source: XDmInboxSource = {
      getXConnectorStatus: async () =>
        ({ connected: true, dmRead: true }) as LifeOpsXConnectorStatus,
      syncXDms: async (syncOpts) => {
        syncCalls.push(syncOpts ?? {});
        const fetched =
          syncOpts?.limit === undefined
            ? newestMixed
            : newestMixed.slice(0, syncOpts.limit);
        for (const row of fetched) {
          if (!cache.some((existing) => existing.id === row.id)) {
            cache.push(row);
          }
        }
        return { synced: fetched.length };
      },
      getXDms: async (opts) => {
        const rows =
          opts?.inbound === undefined
            ? cache
            : cache.filter((row) => row.isInbound === opts.inbound);
        return opts?.limit === undefined ? rows : rows.slice(0, opts.limit);
      },
    };

    const result = await fetchXDmMessages(source, { limit: 3 });

    expect(syncCalls).toEqual([{ limit: 9 }]);
    expect(result.messages.map((message) => message.text)).toEqual([
      "question-3",
      "question-2",
      "question-1",
    ]);
  });
});
