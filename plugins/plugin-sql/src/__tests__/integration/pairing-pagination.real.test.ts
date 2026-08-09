/** Verifies that Drizzle applies pairing bounds before rows leave storage. */
import type { PairingAllowlistEntry, PairingRequest, UUID } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { createIsolatedTestDatabase } from "../test-helpers";

const id = (index: number) =>
  `30000000-0000-0000-0000-${index.toString().padStart(12, "0")}` as UUID;

describe("BaseDrizzleAdapter pairing pagination", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let agentId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("pairing-pagination");
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    agentId = setup.testAgentId;
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it("returns deterministic newest-first request pages with continuation metadata", async () => {
    const requests: PairingRequest[] = [
      {
        id: id(1),
        channel: "msteams",
        senderId: "sender-1",
        code: "CODE0001",
        createdAt: new Date(1_000),
        lastSeenAt: new Date(1_000),
        agentId,
      },
      {
        id: id(2),
        channel: "msteams",
        senderId: "sender-2",
        code: "CODE0002",
        createdAt: new Date(2_000),
        lastSeenAt: new Date(2_000),
        agentId,
      },
      {
        id: id(3),
        channel: "msteams",
        senderId: "sender-3",
        code: "CODE0003",
        createdAt: new Date(2_000),
        lastSeenAt: new Date(2_000),
        agentId,
      },
    ];
    await adapter.createPairingRequests(requests);

    const [legacy] = await adapter.getPairingRequests([{ channel: "msteams", agentId }]);
    expect(legacy.requests.map((request) => request.id)).toEqual([id(1), id(2), id(3)]);
    expect(legacy.pageInfo).toBeUndefined();

    const [firstPage] = await adapter.getPairingRequests([
      {
        channel: "msteams",
        agentId,
        createdAfter: new Date(1_500),
        order: "newest",
        limit: 1,
        offset: 0,
      },
    ]);
    expect(firstPage.requests.map((request) => request.id)).toEqual([id(3)]);
    expect(firstPage.pageInfo).toEqual({
      limit: 1,
      offset: 0,
      hasMore: true,
      nextOffset: 1,
    });

    const [secondPage] = await adapter.getPairingRequests([
      {
        channel: "msteams",
        agentId,
        createdAfter: new Date(1_500),
        order: "newest",
        limit: 1,
        offset: 1,
      },
    ]);
    expect(secondPage.requests.map((request) => request.id)).toEqual([id(2)]);
    expect(secondPage.pageInfo?.nextOffset).toBeNull();
  });

  it("applies the same bounds to allowlist pages", async () => {
    const entries: PairingAllowlistEntry[] = [4, 5, 6].map((index) => ({
      id: id(index),
      channel: "msteams",
      senderId: `allowed-${index}`,
      createdAt: new Date(index * 1_000),
      agentId,
    }));
    await adapter.createPairingAllowlistEntries(entries);

    const [page] = await adapter.getPairingAllowlists([
      {
        channel: "msteams",
        agentId,
        order: "newest",
        limit: 2,
        offset: 0,
      },
    ]);
    expect(page.entries.map((entry) => entry.id)).toEqual([id(6), id(5)]);
    expect(page.pageInfo).toEqual({
      limit: 2,
      offset: 0,
      hasMore: true,
      nextOffset: 2,
    });
  });
});
