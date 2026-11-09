/** Pairing ownership and admission use the real runtime and SQL adapter. */
import { randomUUID } from "node:crypto";
import { AgentRuntime, PairingService, type UUID } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createIsolatedTestDatabase } from "./test-helpers";

describe("pairing state identity", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  beforeAll(async () => {
    fixture = await createIsolatedTestDatabase("pairing-state-identity");
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => fixture?.cleanup());

  it("keeps reply claims separate for distinct channel and sender tuples", () => {
    const service = new PairingService(fixture.runtime);
    expect(service.claimPairingReply("tuple:channel", "sender")).toBe(true);
    expect(service.claimPairingReply("tuple", "channel:sender")).toBe(true);
    expect(service.claimPairingReply("tuple:channel", "sender")).toBe(false);
    expect(service.claimPairingReply("tuple", "channel:sender")).toBe(false);
  });

  it("persists distinct request tuples created in the same millisecond", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const service = new PairingService(fixture.runtime);
    const first = await service.upsertRequest({ channel: "request-a-b", senderId: "c" });
    const second = await service.upsertRequest({ channel: "request-a", senderId: "b-c" });
    expect(first.request?.id).not.toBe(second.request?.id);
    expect((await service.listPendingRequests("request-a-b")).map((row) => row.senderId)).toEqual([
      "c",
    ]);
    expect((await service.listPendingRequests("request-a")).map((row) => row.senderId)).toEqual([
      "b-c",
    ]);
  });

  it("keeps same-millisecond request identities separate across agents", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const agentId = randomUUID() as UUID;
    await fixture.adapter.createAgent({ id: agentId, name: "second pairing owner", settings: {} });
    const otherRuntime = new AgentRuntime({ agentId, character: { name: "second pairing owner" } });
    otherRuntime.registerDatabaseAdapter(fixture.adapter);
    const first = await new PairingService(fixture.runtime).upsertRequest({
      channel: "multi-agent",
      senderId: "sender",
    });
    const secondService = new PairingService(otherRuntime);
    const second = await secondService.upsertRequest({
      channel: "multi-agent",
      senderId: "sender",
    });
    expect(first.request?.id).not.toBe(second.request?.id);
    expect(
      (await secondService.listPendingRequests("multi-agent")).map((row) => row.agentId)
    ).toEqual([agentId]);
  });

  it("persists both allowlist tuples when their delimited strings coincide", async () => {
    const service = new PairingService(fixture.runtime);
    const first = await service.addToAllowlist("grant-a-b", "c");
    const second = await service.addToAllowlist("grant-a", "b-c");
    expect(first.id).not.toBe(second.id);
    expect(await service.isAllowed("grant-a-b", "c")).toBe(true);
    expect(await service.isAllowed("grant-a", "b-c")).toBe(true);
  });

  it("returns the persisted row identity when a duplicate grant is retained", async () => {
    const originalId = randomUUID() as UUID;
    const entry = {
      id: originalId,
      channel: "retained-grant",
      senderId: "sender",
      createdAt: new Date(),
      agentId: fixture.runtime.agentId,
    };
    expect(await fixture.runtime.createPairingAllowlistEntry(entry)).toBe(originalId);
    expect(
      await fixture.runtime.createPairingAllowlistEntry({ ...entry, id: randomUUID() as UUID })
    ).toBe(originalId);
  });

  it("approval returns the existing grant rather than an unpersisted replacement", async () => {
    const service = new PairingService(fixture.runtime);
    const existing = {
      id: randomUUID() as UUID,
      channel: "existing-approval",
      senderId: "sender",
      createdAt: new Date(1_000),
      agentId: fixture.runtime.agentId,
      metadata: { retained: "yes" },
    };
    await fixture.runtime.createPairingAllowlistEntry(existing);
    const pending = await service.upsertRequest({
      channel: existing.channel,
      senderId: existing.senderId,
    });
    const approved = await service.approveCode({ channel: existing.channel, code: pending.code });
    expect(approved?.allowlistEntry).toEqual(existing);
    expect(await service.listPendingRequests(existing.channel)).toEqual([]);
  });

  it("refuses a conflicting grant identity instead of reporting another scope as stored", async () => {
    const id = randomUUID() as UUID;
    const original = {
      id,
      channel: "grant-id-owner",
      senderId: "sender",
      createdAt: new Date(),
      agentId: fixture.runtime.agentId,
    };
    await fixture.runtime.createPairingAllowlistEntry(original);
    await expect(
      fixture.runtime.createPairingAllowlistEntry({ ...original, channel: "grant-id-other" })
    ).rejects.toMatchObject({ code: "PAIRING_ALLOWLIST_ID_CONFLICT" });
    expect(await new PairingService(fixture.runtime).isAllowed("grant-id-other", "sender")).toBe(
      false
    );
  });

  it("retains the approval code after a failed grant and succeeds on retry", async () => {
    const service = new PairingService(fixture.runtime);
    const pending = await service.upsertRequest({ channel: "approval-retry", senderId: "sender" });
    const db = await fixture.adapter.getConnection();
    await db.execute(sql`CREATE FUNCTION pairing_grant_reject() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.channel = 'approval-retry' THEN
        RAISE EXCEPTION 'injected grant persistence failure';
      END IF; RETURN NEW; END $$`);
    await db.execute(sql`CREATE TRIGGER pairing_grant_reject BEFORE INSERT ON pairing_allowlist
      FOR EACH ROW EXECUTE FUNCTION pairing_grant_reject()`);
    try {
      await expect(
        service.approveCode({ channel: "approval-retry", code: pending.code })
      ).rejects.toThrow();
      expect((await service.listPendingRequests("approval-retry")).map((row) => row.code)).toEqual([
        pending.code,
      ]);
      expect(await service.isAllowed("approval-retry", "sender")).toBe(false);
    } finally {
      await db.execute(sql`DROP TRIGGER pairing_grant_reject ON pairing_allowlist`);
      await db.execute(sql`DROP FUNCTION pairing_grant_reject()`);
    }
    const result = await service.approveCode({ channel: "approval-retry", code: pending.code });
    expect(result?.senderId).toBe("sender");
    expect(await service.isAllowed("approval-retry", "sender")).toBe(true);
    expect(await service.listPendingRequests("approval-retry")).toEqual([]);
  });

  it("retains a granted request until failed consumption can retry", async () => {
    const service = new PairingService(fixture.runtime);
    const pending = await service.upsertRequest({ channel: "consume-retry", senderId: "sender" });
    const db = await fixture.adapter.getConnection();
    await db.execute(sql`CREATE FUNCTION pairing_consume_reject() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.channel = 'consume-retry' THEN
        RAISE EXCEPTION 'injected request consumption failure';
      END IF; RETURN OLD; END $$`);
    await db.execute(sql`CREATE TRIGGER pairing_consume_reject BEFORE DELETE ON pairing_requests
      FOR EACH ROW EXECUTE FUNCTION pairing_consume_reject()`);
    try {
      await expect(
        service.approveCode({ channel: "consume-retry", code: pending.code })
      ).rejects.toThrow();
      expect(await service.isAllowed("consume-retry", "sender")).toBe(true);
      expect((await service.listPendingRequests("consume-retry")).map((row) => row.code)).toEqual([
        pending.code,
      ]);
    } finally {
      await db.execute(sql`DROP TRIGGER pairing_consume_reject ON pairing_requests`);
      await db.execute(sql`DROP FUNCTION pairing_consume_reject()`);
    }
    const retained = (await service.getAllowlist("consume-retry"))[0];
    expect(
      (await service.approveCode({ channel: "consume-retry", code: pending.code }))?.allowlistEntry
    ).toEqual(retained);
    expect(await service.listPendingRequests("consume-retry")).toEqual([]);
  });

  it("returns the row retained by a competing grant insertion", async () => {
    const db = await fixture.adapter.getConnection();
    await db.execute(sql`CREATE FUNCTION pairing_competing_grant() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.channel = 'competing-grant' AND NOT (NEW.metadata ? 'winner') THEN
        INSERT INTO pairing_allowlist (id, channel, sender_id, created_at, metadata, agent_id)
        VALUES ('9b59bad3-b068-405b-82f1-292383b55528', NEW.channel, NEW.sender_id,
          '2001-01-01T00:00:00Z', '{"winner":"retained"}', NEW.agent_id);
      END IF; RETURN NEW; END $$`);
    await db.execute(sql`CREATE TRIGGER pairing_competing_grant BEFORE INSERT ON pairing_allowlist
      FOR EACH ROW EXECUTE FUNCTION pairing_competing_grant()`);
    try {
      const result = await new PairingService(fixture.runtime).addToAllowlist(
        "competing-grant",
        "sender",
        { attempt: "loser" }
      );
      expect(result.id).toBe("9b59bad3-b068-405b-82f1-292383b55528");
      expect(result.metadata).toEqual({ winner: "retained" });
      expect(result.createdAt).toEqual(new Date("2001-01-01T00:00:00Z"));
    } finally {
      await db.execute(sql`DROP TRIGGER pairing_competing_grant ON pairing_allowlist`);
      await db.execute(sql`DROP FUNCTION pairing_competing_grant()`);
    }
  });

  it("expires requests after the strict TTL boundary", async () => {
    const timestamp = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(timestamp);
    await fixture.runtime.createPairingRequest({
      id: randomUUID() as UUID,
      agentId: fixture.runtime.agentId,
      channel: "request-expiry",
      senderId: "sender",
      code: "ABCDEFGH",
      createdAt: new Date(timestamp),
      lastSeenAt: new Date(timestamp),
    });
    const service = new PairingService(fixture.runtime, { requestTtlMs: 1_000 });
    clock.mockReturnValue(timestamp + 1_000);
    expect(await service.listPendingRequests("request-expiry")).toHaveLength(1);
    clock.mockReturnValue(timestamp + 1_001);
    expect(await service.listPendingRequests("request-expiry")).toEqual([]);
    expect(await service.approveCode({ channel: "request-expiry", code: "ABCDEFGH" })).toBeNull();
    expect(await service.isAllowed("request-expiry", "sender")).toBe(false);
  });

  it("rearms replies at TTL and explicitly after cache eviction", () => {
    const timestamp = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(timestamp);
    const service = new PairingService(fixture.runtime, { requestTtlMs: 1_000 });
    expect(service.claimPairingReply("reply-window", "sender")).toBe(true);
    clock.mockReturnValue(timestamp + 999);
    expect(service.claimPairingReply("reply-window", "sender")).toBe(false);
    clock.mockReturnValue(timestamp + 1_000);
    expect(service.claimPairingReply("reply-window", "sender")).toBe(true);
    for (let index = 0; index < 4_096; index += 1) {
      expect(service.claimPairingReply("reply-window", `flood-${index}`)).toBe(true);
    }
    expect(service.claimPairingReply("reply-window", "sender")).toBe(true);
    expect(service.claimPairingReply("reply-window", "flood-4095")).toBe(false);
  });

  it("serializes concurrent admission at the cap without evicting a pending sender", async () => {
    const service = new PairingService(fixture.runtime, { maxPendingRequests: 2 });
    const results = await Promise.all(
      ["one", "two", "three"].map((senderId) =>
        service.upsertRequest({ channel: "capacity", senderId })
      )
    );
    expect(results.map((result) => result.created)).toEqual([true, true, false]);
    expect(
      (await service.listPendingRequests("capacity")).map((row) => row.senderId).sort()
    ).toEqual(["one", "two"]);
    expect((await service.upsertRequest({ channel: "capacity", senderId: "one" })).code).toBe(
      results[0].code
    );
  });

  it("keeps the admission queue usable after a real persistence failure", async () => {
    const db = await fixture.adapter.getConnection();
    await db.execute(sql`CREATE FUNCTION pairing_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.channel = 'failed-admission' AND NEW.sender_id = 'reject' THEN
        RAISE EXCEPTION 'injected pairing persistence failure';
      END IF; RETURN NEW; END $$`);
    await db.execute(sql`CREATE TRIGGER pairing_test_reject BEFORE INSERT ON pairing_requests
      FOR EACH ROW EXECUTE FUNCTION pairing_test_reject()`);
    const service = new PairingService(fixture.runtime);
    try {
      await expect(
        service.upsertRequest({ channel: "failed-admission", senderId: "reject" })
      ).rejects.toThrow();
      expect(
        (await service.upsertRequest({ channel: "failed-admission", senderId: "accepted" })).created
      ).toBe(true);
      expect(
        (await service.listPendingRequests("failed-admission")).map((row) => row.senderId)
      ).toEqual(["accepted"]);
    } finally {
      await db.execute(sql`DROP TRIGGER pairing_test_reject ON pairing_requests`);
      await db.execute(sql`DROP FUNCTION pairing_test_reject()`);
    }
  });
});
