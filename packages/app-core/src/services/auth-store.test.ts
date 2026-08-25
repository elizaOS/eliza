/**
 * Unit tests for AuthStore — pglite-backed identity, session, binding, JTI,
 * login-token, and audit-event repositories. Each case opens a fresh database
 * and runs plugin-sql migrations so queries hit the real schema rather than a
 * mock. Assertions record observed store behaviour, including where comments
 * overstate the SQL predicate (consumeOwnerLoginToken does not check expiry).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore, type DrizzleDatabase } from "./auth-store";

interface Harness {
  db: DrizzleDatabase;
  store: AuthStore;
  cleanup: () => Promise<void>;
}

interface AdapterWithDb {
  db?: unknown;
  initialize?: () => Promise<void>;
  init?: () => Promise<void>;
  close?: () => Promise<void>;
}

interface SqlPluginModule {
  createDatabaseAdapter: (
    cfg: { dataDir: string },
    id: `${string}-${string}-${string}-${string}-${string}`,
  ) => unknown;
  DatabaseMigrationService: new () => {
    initializeWithDatabase: (db: unknown) => Promise<void>;
    discoverAndRegisterPluginSchemas: (plugins: unknown[]) => void;
    runAllPluginMigrations: () => Promise<void>;
  };
  plugin: unknown;
}

async function open(): Promise<Harness> {
  const {
    createDatabaseAdapter,
    DatabaseMigrationService,
    plugin: sqlPlugin,
  } = (await import("@elizaos/plugin-sql")) as SqlPluginModule;
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-auth-store-unit-"),
  );
  const adapter = createDatabaseAdapter(
    { dataDir },
    "00000000-0000-0000-0000-000000000001" as `${string}-${string}-${string}-${string}-${string}`,
  ) as AdapterWithDb;
  if (typeof adapter.initialize === "function") {
    await adapter.initialize();
  } else if (typeof adapter.init === "function") {
    await adapter.init();
  }
  if (!adapter.db) {
    throw new Error("test harness: adapter has no .db");
  }
  const db = adapter.db as DrizzleDatabase;
  const migrations = new DatabaseMigrationService();
  await migrations.initializeWithDatabase(db);
  migrations.discoverAndRegisterPluginSchemas([sqlPlugin]);
  await migrations.runAllPluginMigrations();
  const store = new AuthStore(db);
  return {
    db,
    store,
    cleanup: async () => {
      try {
        await adapter.close?.();
      } catch {
        // pglite shutdown can throw on a wiped data dir; that's fine.
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function seedOwner(
  store: AuthStore,
  id = "ident-owner",
  displayName = "Owner",
) {
  return store.createIdentity({
    id,
    kind: "owner",
    displayName,
    createdAt: 1_000,
  });
}

async function seedSession(
  store: AuthStore,
  input: {
    id: string;
    identityId: string;
    lastSeenAt?: number;
    expiresAt?: number;
    kind?: "browser" | "machine";
    scopes?: string[];
  },
) {
  return store.createSession({
    id: input.id,
    identityId: input.identityId,
    kind: input.kind ?? "browser",
    createdAt: 10_000,
    lastSeenAt: input.lastSeenAt ?? 10_000,
    expiresAt: input.expiresAt ?? 99_999,
    rememberDevice: false,
    csrfSecret: "csrf",
    ip: "127.0.0.1",
    userAgent: "vitest",
    scopes: input.scopes ?? [],
  });
}

describe("AuthStore", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await open();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("createIdentity stores omitted passwordHash and cloudUserId as null", async () => {
    const created = await harness.store.createIdentity({
      id: "ident-omit",
      kind: "owner",
      displayName: "Omitted",
      createdAt: 42,
    });
    expect(created.passwordHash).toBeNull();
    expect(created.cloudUserId).toBeNull();
    expect(created.kind).toBe("owner");
    expect(created.createdAt).toBe(42);
  });

  it("createIdentity persists a machine identity distinct from owner", async () => {
    const machine = await harness.store.createIdentity({
      id: "ident-machine",
      kind: "machine",
      displayName: "Bot",
      createdAt: 7,
      passwordHash: "hash",
      cloudUserId: null,
    });
    expect(machine.kind).toBe("machine");
    expect(machine.passwordHash).toBe("hash");
    const found = await harness.store.findIdentity("ident-machine");
    expect(found).toEqual(machine);
  });

  it("findIdentity returns null for a missing id and the row for a hit", async () => {
    await seedOwner(harness.store);
    expect(await harness.store.findIdentity("missing")).toBeNull();
    const hit = await harness.store.findIdentity("ident-owner");
    expect(hit?.displayName).toBe("Owner");
  });

  it("findIdentityByCloudUserId returns null when no identity is linked", async () => {
    await seedOwner(harness.store);
    expect(await harness.store.findIdentityByCloudUserId("nobody")).toBeNull();
  });

  it("findIdentityByDisplayName finds a row and returns null when missing", async () => {
    await seedOwner(harness.store, "ident-dn", "UniqueName");
    const hit = await harness.store.findIdentityByDisplayName("UniqueName");
    expect(hit?.id).toBe("ident-dn");
    expect(await harness.store.findIdentityByDisplayName("nope")).toBeNull();
  });

  it("updateIdentityPassword writes the hash so a later find sees it", async () => {
    await seedOwner(harness.store);
    await harness.store.updateIdentityPassword("ident-owner", "argon2id$new");
    const found = await harness.store.findIdentity("ident-owner");
    expect(found?.passwordHash).toBe("argon2id$new");
  });

  it("listIdentitiesByKind returns empty for an unused kind and filters mixed rows", async () => {
    expect(await harness.store.listIdentitiesByKind("owner")).toEqual([]);
    expect(await harness.store.listIdentitiesByKind("machine")).toEqual([]);
    await seedOwner(harness.store, "o1", "A");
    await seedOwner(harness.store, "o2", "B");
    await harness.store.createIdentity({
      id: "m1",
      kind: "machine",
      displayName: "M",
      createdAt: 2,
    });
    const owners = await harness.store.listIdentitiesByKind("owner");
    expect(owners.map((row) => row.id).sort()).toEqual(["o1", "o2"]);
    const machines = await harness.store.listIdentitiesByKind("machine");
    expect(machines).toHaveLength(1);
    expect(machines[0]?.id).toBe("m1");
  });

  it("hasOwnerIdentity is false until an owner row exists and ignores machines", async () => {
    expect(await harness.store.hasOwnerIdentity()).toBe(false);
    await harness.store.createIdentity({
      id: "m-only",
      kind: "machine",
      displayName: "Machine",
      createdAt: 1,
    });
    expect(await harness.store.hasOwnerIdentity()).toBe(false);
    await seedOwner(harness.store);
    expect(await harness.store.hasOwnerIdentity()).toBe(true);
  });

  it("createSession round-trips machine kind and non-empty scopes", async () => {
    await seedOwner(harness.store);
    const session = await seedSession(harness.store, {
      id: "sess-machine",
      identityId: "ident-owner",
      kind: "machine",
      scopes: ["read", "write"],
    });
    expect(session.kind).toBe("machine");
    expect(session.scopes).toEqual(["read", "write"]);
    expect(session.revokedAt).toBeNull();
    expect(session.rememberDevice).toBe(false);
  });

  it("findSession returns null for an unknown id", async () => {
    expect(await harness.store.findSession("no-such", 1)).toBeNull();
  });

  it("findSession returns the row while unrevoked and unexpired", async () => {
    await seedOwner(harness.store);
    await seedSession(harness.store, {
      id: "sess-live",
      identityId: "ident-owner",
      expiresAt: 500,
    });
    const found = await harness.store.findSession("sess-live", 499);
    expect(found?.id).toBe("sess-live");
  });

  it("findSession treats expiresAt equal to now as expired", async () => {
    await seedOwner(harness.store);
    await seedSession(harness.store, {
      id: "sess-eq",
      identityId: "ident-owner",
      expiresAt: 200,
    });
    expect(await harness.store.findSession("sess-eq", 200)).toBeNull();
  });

  it("findSession returns null once revokedAt is set", async () => {
    await seedOwner(harness.store);
    await seedSession(harness.store, {
      id: "sess-rev",
      identityId: "ident-owner",
      expiresAt: 9_999,
    });
    expect(await harness.store.revokeSession("sess-rev", 50)).toBe(true);
    expect(await harness.store.findSession("sess-rev", 51)).toBeNull();
  });

  it("revokeSession reports true when the driver omits rowCount, even for a missing id", async () => {
    // readRunRowCount returns null for pglite update results, and revokeSession
    // treats a missing count as success. The mutation is verified via findSession.
    await seedOwner(harness.store);
    await seedSession(harness.store, {
      id: "sess-once",
      identityId: "ident-owner",
    });
    expect(await harness.store.revokeSession("missing", 1)).toBe(true);
    expect(await harness.store.revokeSession("sess-once", 2)).toBe(true);
    expect(await harness.store.findSession("sess-once", 3)).toBeNull();
    expect(await harness.store.revokeSession("sess-once", 4)).toBe(true);
  });

  it("touchSession slides lastSeenAt and expiresAt on an active session", async () => {
    await seedOwner(harness.store);
    await seedSession(harness.store, {
      id: "sess-touch",
      identityId: "ident-owner",
      lastSeenAt: 10,
      expiresAt: 100,
    });
    await harness.store.touchSession("sess-touch", 40, 400);
    const found = await harness.store.findSession("sess-touch", 50);
    expect(found?.lastSeenAt).toBe(40);
    expect(found?.expiresAt).toBe(400);
  });

  it("touchSession does not revive a revoked session", async () => {
    await seedOwner(harness.store);
    await seedSession(harness.store, {
      id: "sess-dead",
      identityId: "ident-owner",
      expiresAt: 9_999,
    });
    await harness.store.revokeSession("sess-dead", 5);
    await harness.store.touchSession("sess-dead", 80, 8_000);
    expect(await harness.store.findSession("sess-dead", 90)).toBeNull();
  });

  it("revokeAllSessionsForIdentity returns 0 on an empty identity", async () => {
    expect(await harness.store.revokeAllSessionsForIdentity("nobody", 1)).toBe(
      0,
    );
  });

  it("revokeAllSessionsForIdentity revokes every active session for that identity", async () => {
    await seedOwner(harness.store, "a");
    await seedOwner(harness.store, "b");
    await seedSession(harness.store, { id: "a1", identityId: "a" });
    await seedSession(harness.store, { id: "a2", identityId: "a" });
    await seedSession(harness.store, { id: "b1", identityId: "b" });
    const n = await harness.store.revokeAllSessionsForIdentity("a", 77);
    // pglite update results omit rowCount, so the store returns 0 even when
    // rows were written. Presence of the mutation is checked via findSession.
    expect(n).toBe(0);
    expect(await harness.store.findSession("a1", 78)).toBeNull();
    expect(await harness.store.findSession("a2", 78)).toBeNull();
    expect((await harness.store.findSession("b1", 78))?.id).toBe("b1");
  });

  it("revokeAllSessionsForIdentity skips the exceptSessionId and already-revoked rows", async () => {
    await seedOwner(harness.store);
    await seedSession(harness.store, { id: "keep", identityId: "ident-owner" });
    await seedSession(harness.store, { id: "drop", identityId: "ident-owner" });
    await seedSession(harness.store, { id: "gone", identityId: "ident-owner" });
    await harness.store.revokeSession("gone", 1);
    const n = await harness.store.revokeAllSessionsForIdentity(
      "ident-owner",
      2,
      "keep",
    );
    expect(n).toBe(0);
    expect((await harness.store.findSession("keep", 3))?.id).toBe("keep");
    expect(await harness.store.findSession("drop", 3)).toBeNull();
    expect(await harness.store.findSession("gone", 3)).toBeNull();
  });

  it("listSessionsForIdentity returns empty when the identity has no sessions", async () => {
    await seedOwner(harness.store);
    expect(
      await harness.store.listSessionsForIdentity("ident-owner", 1),
    ).toEqual([]);
  });

  it("listSessionsForIdentity returns a single live session", async () => {
    await seedOwner(harness.store);
    await seedSession(harness.store, {
      id: "only",
      identityId: "ident-owner",
      lastSeenAt: 5,
    });
    const listed = await harness.store.listSessionsForIdentity(
      "ident-owner",
      6,
    );
    expect(listed.map((row) => row.id)).toEqual(["only"]);
  });

  it("listSessionsForIdentity orders newest lastSeenAt first and drops revoked or expired", async () => {
    await seedOwner(harness.store);
    await seedSession(harness.store, {
      id: "old",
      identityId: "ident-owner",
      lastSeenAt: 10,
      expiresAt: 9_999,
    });
    await seedSession(harness.store, {
      id: "new",
      identityId: "ident-owner",
      lastSeenAt: 30,
      expiresAt: 9_999,
    });
    await seedSession(harness.store, {
      id: "mid",
      identityId: "ident-owner",
      lastSeenAt: 20,
      expiresAt: 9_999,
    });
    await seedSession(harness.store, {
      id: "expired",
      identityId: "ident-owner",
      lastSeenAt: 40,
      expiresAt: 50,
    });
    await seedSession(harness.store, {
      id: "revoked",
      identityId: "ident-owner",
      lastSeenAt: 50,
      expiresAt: 9_999,
    });
    await harness.store.revokeSession("revoked", 1);
    const listed = await harness.store.listSessionsForIdentity(
      "ident-owner",
      50,
    );
    expect(listed.map((row) => row.id)).toEqual(["new", "mid", "old"]);
  });

  it("listSessionsForIdentity keeps both rows when lastSeenAt ties", async () => {
    await seedOwner(harness.store);
    await seedSession(harness.store, {
      id: "tie-a",
      identityId: "ident-owner",
      lastSeenAt: 7,
    });
    await seedSession(harness.store, {
      id: "tie-b",
      identityId: "ident-owner",
      lastSeenAt: 7,
    });
    const listed = await harness.store.listSessionsForIdentity(
      "ident-owner",
      8,
    );
    expect(listed).toHaveLength(2);
    expect(listed.map((row) => row.id).sort()).toEqual(["tie-a", "tie-b"]);
    expect(listed.every((row) => row.lastSeenAt === 7)).toBe(true);
  });

  it("recordJtiSeen is true on first insert and false on replay of the same jti", async () => {
    expect(await harness.store.recordJtiSeen("jti-x", 1)).toBe(true);
    expect(await harness.store.recordJtiSeen("jti-x", 2)).toBe(false);
    expect(await harness.store.recordJtiSeen("jti-y", 3)).toBe(true);
  });

  it("pruneJtiSeenBefore deletes rows with seenAt less than or equal to the threshold", async () => {
    expect(await harness.store.recordJtiSeen("old", 10)).toBe(true);
    expect(await harness.store.recordJtiSeen("eq", 20)).toBe(true);
    expect(await harness.store.recordJtiSeen("keep", 21)).toBe(true);
    await harness.store.pruneJtiSeenBefore(20);
    expect(await harness.store.recordJtiSeen("old", 30)).toBe(true);
    expect(await harness.store.recordJtiSeen("eq", 30)).toBe(true);
    expect(await harness.store.recordJtiSeen("keep", 30)).toBe(false);
  });

  it("appendAuditEvent round-trips a failure outcome and actor fields", async () => {
    const event = await harness.store.appendAuditEvent({
      id: "audit-fail",
      ts: 9,
      actorIdentityId: "ident-actor",
      ip: "10.0.0.1",
      userAgent: "ua",
      action: "auth.login",
      outcome: "failure",
      metadata: { reason: "bad-password" },
    });
    expect(event.outcome).toBe("failure");
    expect(event.actorIdentityId).toBe("ident-actor");
    expect(event.ip).toBe("10.0.0.1");
    expect(event.userAgent).toBe("ua");
    expect(event.metadata).toEqual({ reason: "bad-password" });
  });

  it("appendAuditEvent stores null actor/ip/userAgent when omitted as null", async () => {
    const event = await harness.store.appendAuditEvent({
      id: "audit-ok",
      ts: 1,
      actorIdentityId: null,
      ip: null,
      userAgent: null,
      action: "auth.bootstrap",
      outcome: "success",
      metadata: {},
    });
    expect(event.outcome).toBe("success");
    expect(event.actorIdentityId).toBeNull();
    expect(event.metadata).toEqual({});
  });

  it("createOwnerBinding then findOwnerBinding round-trips pending fields", async () => {
    await seedOwner(harness.store);
    await harness.store.createOwnerBinding({
      id: "bind-1",
      identityId: "ident-owner",
      connector: "discord",
      externalId: "ext-1",
      displayHandle: "alice",
      instanceId: "inst-a",
      verifiedAt: 11,
      pendingCodeHash: "hash-1",
      pendingExpiresAt: 99,
    });
    const found = await harness.store.findOwnerBinding("bind-1");
    expect(found).toEqual({
      id: "bind-1",
      identityId: "ident-owner",
      connector: "discord",
      externalId: "ext-1",
      displayHandle: "alice",
      instanceId: "inst-a",
      verifiedAt: 11,
      pendingCodeHash: "hash-1",
      pendingExpiresAt: 99,
    });
  });

  it("createOwnerBinding stores omitted pending fields as null", async () => {
    await seedOwner(harness.store);
    await harness.store.createOwnerBinding({
      id: "bind-plain",
      identityId: "ident-owner",
      connector: "telegram",
      externalId: "ext-2",
      displayHandle: "bob",
      instanceId: "inst-a",
      verifiedAt: 1,
    });
    const found = await harness.store.findOwnerBinding("bind-plain");
    expect(found?.pendingCodeHash).toBeNull();
    expect(found?.pendingExpiresAt).toBeNull();
  });

  it("findOwnerBinding returns null for a missing id", async () => {
    expect(await harness.store.findOwnerBinding("nope")).toBeNull();
  });

  it("findOwnerBindingByPendingCodeHash requires both hash and instanceId", async () => {
    await seedOwner(harness.store);
    await harness.store.createOwnerBinding({
      id: "bind-pending",
      identityId: "ident-owner",
      connector: "discord",
      externalId: "ext-p",
      displayHandle: "pat",
      instanceId: "inst-a",
      verifiedAt: 1,
      pendingCodeHash: "code-hash",
      pendingExpiresAt: 50,
    });
    const hit = await harness.store.findOwnerBindingByPendingCodeHash(
      "code-hash",
      "inst-a",
    );
    expect(hit?.id).toBe("bind-pending");
    expect(
      await harness.store.findOwnerBindingByPendingCodeHash(
        "code-hash",
        "other-inst",
      ),
    ).toBeNull();
    expect(
      await harness.store.findOwnerBindingByPendingCodeHash("wrong", "inst-a"),
    ).toBeNull();
  });

  it("findOwnerBindingByConnectorPair matches the triple and misses otherwise", async () => {
    await seedOwner(harness.store);
    await harness.store.createOwnerBinding({
      id: "bind-pair",
      identityId: "ident-owner",
      connector: "discord",
      externalId: "ext-pair",
      displayHandle: "pair",
      instanceId: "inst-a",
      verifiedAt: 1,
    });
    const hit = await harness.store.findOwnerBindingByConnectorPair({
      connector: "discord",
      externalId: "ext-pair",
      instanceId: "inst-a",
    });
    expect(hit?.id).toBe("bind-pair");
    expect(
      await harness.store.findOwnerBindingByConnectorPair({
        connector: "discord",
        externalId: "ext-pair",
        instanceId: "other",
      }),
    ).toBeNull();
  });

  it("listOwnerBindingsForIdentity is empty, then newest verifiedAt first", async () => {
    await seedOwner(harness.store);
    expect(
      await harness.store.listOwnerBindingsForIdentity("ident-owner"),
    ).toEqual([]);
    await harness.store.createOwnerBinding({
      id: "old-bind",
      identityId: "ident-owner",
      connector: "discord",
      externalId: "1",
      displayHandle: "old",
      instanceId: "inst-a",
      verifiedAt: 10,
    });
    await harness.store.createOwnerBinding({
      id: "new-bind",
      identityId: "ident-owner",
      connector: "telegram",
      externalId: "2",
      displayHandle: "new",
      instanceId: "inst-a",
      verifiedAt: 30,
    });
    await harness.store.createOwnerBinding({
      id: "mid-bind",
      identityId: "ident-owner",
      connector: "matrix",
      externalId: "3",
      displayHandle: "mid",
      instanceId: "inst-a",
      verifiedAt: 20,
    });
    const listed =
      await harness.store.listOwnerBindingsForIdentity("ident-owner");
    expect(listed.map((row) => row.id)).toEqual([
      "new-bind",
      "mid-bind",
      "old-bind",
    ]);
  });

  it("updateOwnerBindingPending writes then clears the pairing code", async () => {
    await seedOwner(harness.store);
    await harness.store.createOwnerBinding({
      id: "bind-upd",
      identityId: "ident-owner",
      connector: "discord",
      externalId: "ext-u",
      displayHandle: "upd",
      instanceId: "inst-a",
      verifiedAt: 1,
    });
    await harness.store.updateOwnerBindingPending("bind-upd", "next-hash", 500);
    expect(
      (await harness.store.findOwnerBinding("bind-upd"))?.pendingCodeHash,
    ).toBe("next-hash");
    await harness.store.updateOwnerBindingPending("bind-upd", null, null);
    const cleared = await harness.store.findOwnerBinding("bind-upd");
    expect(cleared?.pendingCodeHash).toBeNull();
    expect(cleared?.pendingExpiresAt).toBeNull();
  });

  it("markOwnerBindingVerified updates handle and clears pending fields", async () => {
    await seedOwner(harness.store);
    await harness.store.createOwnerBinding({
      id: "bind-ver",
      identityId: "ident-owner",
      connector: "discord",
      externalId: "ext-v",
      displayHandle: "pending-name",
      instanceId: "inst-a",
      verifiedAt: 1,
      pendingCodeHash: "pending",
      pendingExpiresAt: 9,
    });
    await harness.store.markOwnerBindingVerified(
      "bind-ver",
      88,
      "verified-name",
    );
    const found = await harness.store.findOwnerBinding("bind-ver");
    expect(found?.verifiedAt).toBe(88);
    expect(found?.displayHandle).toBe("verified-name");
    expect(found?.pendingCodeHash).toBeNull();
    expect(found?.pendingExpiresAt).toBeNull();
  });

  it("deleteOwnerBinding removes the row; missing ids still report true without rowCount", async () => {
    await seedOwner(harness.store);
    await harness.store.createOwnerBinding({
      id: "bind-del",
      identityId: "ident-owner",
      connector: "discord",
      externalId: "ext-d",
      displayHandle: "del",
      instanceId: "inst-a",
      verifiedAt: 1,
    });
    expect(await harness.store.deleteOwnerBinding("bind-del")).toBe(true);
    expect(await harness.store.findOwnerBinding("bind-del")).toBeNull();
    expect(await harness.store.deleteOwnerBinding("bind-del")).toBe(true);
    expect(await harness.store.deleteOwnerBinding("never-existed")).toBe(true);
  });

  it("createOwnerLoginToken plus findOwnerLoginToken round-trips an unconsumed token", async () => {
    await seedOwner(harness.store);
    await harness.store.createOwnerBinding({
      id: "bind-tok",
      identityId: "ident-owner",
      connector: "discord",
      externalId: "ext-t",
      displayHandle: "tok",
      instanceId: "inst-a",
      verifiedAt: 1,
    });
    await harness.store.createOwnerLoginToken({
      tokenHash: "sha-live",
      identityId: "ident-owner",
      bindingId: "bind-tok",
      issuedAt: 10,
      expiresAt: 100,
    });
    const found = await harness.store.findOwnerLoginToken("sha-live");
    expect(found).toEqual({
      tokenHash: "sha-live",
      identityId: "ident-owner",
      bindingId: "bind-tok",
      issuedAt: 10,
      expiresAt: 100,
      consumedAt: null,
    });
    expect(await harness.store.findOwnerLoginToken("missing")).toBeNull();
  });

  it("consumeOwnerLoginToken writes consumedAt once; reuse still reports true without rowCount", async () => {
    await seedOwner(harness.store);
    await harness.store.createOwnerBinding({
      id: "bind-c",
      identityId: "ident-owner",
      connector: "discord",
      externalId: "ext-c",
      displayHandle: "c",
      instanceId: "inst-a",
      verifiedAt: 1,
    });
    await harness.store.createOwnerLoginToken({
      tokenHash: "sha-once",
      identityId: "ident-owner",
      bindingId: "bind-c",
      issuedAt: 10,
      expiresAt: 100,
    });
    expect(await harness.store.consumeOwnerLoginToken("sha-once", 20)).toBe(
      true,
    );
    const consumed = await harness.store.findOwnerLoginToken("sha-once");
    expect(consumed?.consumedAt).toBe(20);
    expect(await harness.store.consumeOwnerLoginToken("sha-once", 21)).toBe(
      true,
    );
    expect(
      (await harness.store.findOwnerLoginToken("sha-once"))?.consumedAt,
    ).toBe(20);
    expect(await harness.store.consumeOwnerLoginToken("missing", 22)).toBe(
      true,
    );
  });

  it("consumeOwnerLoginToken still succeeds when expiresAt has already passed", async () => {
    // The SQL predicate is (tokenHash, consumedAt IS NULL) only. Expiry is not
    // checked here; callers that need that guard must apply it themselves.
    await seedOwner(harness.store);
    await harness.store.createOwnerBinding({
      id: "bind-exp",
      identityId: "ident-owner",
      connector: "discord",
      externalId: "ext-e",
      displayHandle: "e",
      instanceId: "inst-a",
      verifiedAt: 1,
    });
    await harness.store.createOwnerLoginToken({
      tokenHash: "sha-expired",
      identityId: "ident-owner",
      bindingId: "bind-exp",
      issuedAt: 10,
      expiresAt: 50,
    });
    expect(await harness.store.consumeOwnerLoginToken("sha-expired", 200)).toBe(
      true,
    );
  });
});
