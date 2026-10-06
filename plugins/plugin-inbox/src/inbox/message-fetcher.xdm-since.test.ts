/**
 * fetchXDmMessages must apply sinceIso before the result limit: the cache
 * read is newest-first, so capping to limit before dropping out-of-window
 * rows hides valid in-window DMs. Deterministic stub source, no network or
 * database. Mirrors the Gmail sinceIso repair.
 */
import { describe, expect, it, vi } from "vitest";
import { fetchXDmMessages } from "./message-fetcher.js";

function xdmRow(id: string, receivedAt: string) {
  return {
    id,
    agentId: "agent",
    externalDmId: id,
    conversationId: "conv-1",
    senderHandle: "friend",
    senderId: "friend-id",
    isInbound: true,
    text: id,
    receivedAt,
    readAt: null,
    repliedAt: null,
    metadata: {},
    syncedAt: "2026-07-11T08:00:00.000Z",
    updatedAt: "2026-07-11T08:00:00.000Z",
  };
}

function xdmSource(rows: ReturnType<typeof xdmRow>[]) {
  return {
    getXConnectorStatus: async () => ({ connected: true, dmRead: true }),
    syncXDms: async () => ({ synced: rows.length }),
    getXDms: vi.fn(async (opts?: { limit?: number; inbound?: boolean }) => {
      const filtered =
        opts?.inbound === undefined
          ? rows
          : rows.filter((row) => row.isInbound === opts.inbound);
      return opts?.limit === undefined
        ? filtered
        : filtered.slice(0, opts.limit);
    }),
  };
}

describe("fetchXDmMessages sinceIso window", () => {
  it("returns an in-window DM past a capped out-of-window row", async () => {
    const source = xdmSource([
      xdmRow("old-out-of-window", "2026-01-01T00:00:00.000Z"),
      xdmRow("new-valid", "2026-07-11T07:00:00.000Z"),
    ]);

    const result = await fetchXDmMessages(source as never, {
      limit: 1,
      sinceIso: "2026-06-01T00:00:00.000Z",
    });

    expect(result.messages.map((message) => message.text)).toEqual([
      "new-valid",
    ]);
  });

  it("does not cap the cache read when filtering by sinceIso", async () => {
    const source = xdmSource([
      xdmRow("old-out-of-window", "2026-01-01T00:00:00.000Z"),
      xdmRow("new-valid", "2026-07-11T07:00:00.000Z"),
    ]);

    await fetchXDmMessages(source as never, {
      limit: 1,
      sinceIso: "2026-06-01T00:00:00.000Z",
    });

    expect(source.getXDms).toHaveBeenCalledWith(
      expect.not.objectContaining({ limit: expect.anything() }),
    );
  });

  it("still caps the cache read when no sinceIso is given", async () => {
    const source = xdmSource([
      xdmRow("first", "2026-07-11T07:00:00.000Z"),
      xdmRow("second", "2026-07-11T06:00:00.000Z"),
    ]);

    const result = await fetchXDmMessages(source as never, { limit: 1 });

    expect(result.messages.map((message) => message.text)).toEqual(["first"]);
    expect(source.getXDms).toHaveBeenCalledWith({ limit: 1, inbound: true });
  });
});
