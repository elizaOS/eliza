/** Exercises bounded pairing reads through the standalone in-memory plugin. */
import type { PairingAllowlistEntry, PairingRequest, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

const AGENT_ID = "20000000-0000-0000-0000-000000000001" as UUID;

function id(index: number): UUID {
  return `20000000-0000-0000-0000-${index.toString().padStart(12, "0")}` as UUID;
}

function request(index: number, createdAt = index * 1_000): PairingRequest {
  return {
    id: id(index),
    channel: "telegram",
    senderId: `sender-${index}`,
    code: `CODE${index}`,
    createdAt: new Date(createdAt),
    lastSeenAt: new Date(createdAt),
    agentId: AGENT_ID,
  };
}

function entry(index: number, createdAt = index * 1_000): PairingAllowlistEntry {
  return {
    id: id(index),
    channel: "telegram",
    senderId: `allowed-${index}`,
    createdAt: new Date(createdAt),
    agentId: AGENT_ID,
  };
}

describe("plugin-inmemorydb pairing pagination", () => {
  it("orders, filters, and bounds request and allowlist queries", async () => {
    const adapter = new InMemoryDatabaseAdapter(new MemoryStorage(), AGENT_ID);
    await adapter.initialize();
    await adapter.createPairingRequests([request(3, 2_000), request(1), request(2, 2_000)]);
    await adapter.createPairingAllowlistEntries([
      entry(6, 2_000),
      entry(4, 1_000),
      entry(5, 2_000),
    ]);

    const [legacyRequests] = await adapter.getPairingRequests([
      { channel: "telegram", agentId: AGENT_ID },
    ]);
    expect(legacyRequests.requests.map((item) => item.id)).toEqual([id(3), id(1), id(2)]);

    const [legacyAllowlist] = await adapter.getPairingAllowlists([
      { channel: "telegram", agentId: AGENT_ID },
    ]);
    expect(legacyAllowlist.entries.map((item) => item.id)).toEqual([id(6), id(4), id(5)]);

    const [requests] = await adapter.getPairingRequests([
      {
        channel: "telegram",
        agentId: AGENT_ID,
        createdAfter: new Date(1_500),
        order: "newest",
        limit: 1,
        offset: 1,
      },
    ]);
    expect(requests.requests.map((item) => item.id)).toEqual([id(2)]);
    expect(requests.pageInfo).toEqual({
      limit: 1,
      offset: 1,
      hasMore: false,
      nextOffset: null,
    });

    const [allowlist] = await adapter.getPairingAllowlists([
      {
        channel: "telegram",
        agentId: AGENT_ID,
        order: "newest",
        limit: 2,
        offset: 0,
      },
    ]);
    expect(allowlist.entries.map((item) => item.id)).toEqual([id(6), id(5)]);
    expect(allowlist.pageInfo).toEqual({
      limit: 2,
      offset: 0,
      hasMore: true,
      nextOffset: 2,
    });
  });

  it("safely handles invalid date timestamps during order sorting", async () => {
    const adapter = new InMemoryDatabaseAdapter(new MemoryStorage(), AGENT_ID);
    await adapter.initialize();
    const req1 = request(1, 1_000);
    const req2 = request(2, 2_000);
    // Force an invalid date timestamp
    (req1 as unknown as { createdAt: unknown }).createdAt = "invalid-date-string";

    await adapter.createPairingRequests([req1, req2]);
    const [sorted] = await adapter.getPairingRequests([
      { channel: "telegram", agentId: AGENT_ID, order: "newest" },
    ]);
    expect(sorted.requests).toHaveLength(2);
    expect(sorted.requests[0].id).toBe(id(2));
  });
});
