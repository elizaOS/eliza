/**
 * Real-pglite tests for `AuthStore`.
 *
 * Project memory: NEVER mock SQL. We open a fresh pglite instance per test
 * and run the real plugin-sql migrations so every method exercises the
 * actual schema.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createDatabaseAdapter,
  DatabaseMigrationService,
  type DrizzleDatabase,
  plugin as sqlPlugin,
} from "@elizaos/plugin-sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore } from "./auth-store";

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

async function open(): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-auth-store-"));
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

describe("AuthStore (real pglite)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await open();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("createIdentity returns the inserted row", async () => {
    const created = await harness.store.createIdentity({
      id: "ident-001",
      kind: "owner",
      displayName: "Alice",
      createdAt: 1000,
      passwordHash: null,
      cloudUserId: "cloud-alice",
    });
    expect(created.id).toBe("ident-001");
    expect(created.kind).toBe("owner");
    expect(created.cloudUserId).toBe("cloud-alice");
    expect(created.passwordHash).toBeNull();
  });

  it("findIdentity returns null for unknown id", async () => {
    const none = await harness.store.findIdentity("missing");
    expect(none).toBeNull();
  });

  it("findIdentityByCloudUserId resolves a linked identity", async () => {
    await harness.store.createIdentity({
      id: "ident-002",
      kind: "owner",
      displayName: "Bob",
      createdAt: 2000,
      cloudUserId: "cloud-bob",
    });
    const got = await harness.store.findIdentityByCloudUserId("cloud-bob");
    expect(got?.id).toBe("ident-002");
  });

  it("createSession + findSession round-trips with sliding expiry", async () => {
    await harness.store.createIdentity({
      id: "ident-003",
      kind: "owner",
      displayName: "Carol",
      createdAt: 3000,
    });
    const now = 10_000;
    await harness.store.createSession({
      id: "sess-001",
      identityId: "ident-003",
      kind: "browser",
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + 1000,
      rememberDevice: false,
      csrfSecret: "secret",
      ip: "127.0.0.1",
      userAgent: "test-agent",
      scopes: [],
    });
    const found = await harness.store.findSession("sess-001", now);
    expect(found?.id).toBe("sess-001");
    expect(found?.kind).toBe("browser");
    expect(found?.scopes).toEqual([]);
  });

  it("findSession returns null for an expired session", async () => {
    await harness.store.createIdentity({
      id: "ident-004",
      kind: "owner",
      displayName: "Dan",
      createdAt: 4000,
    });
    await harness.store.createSession({
      id: "sess-old",
      identityId: "ident-004",
      kind: "browser",
      createdAt: 1,
      lastSeenAt: 1,
      expiresAt: 100,
      rememberDevice: false,
      csrfSecret: "x",
      ip: null,
      userAgent: null,
      scopes: [],
    });
    const found = await harness.store.findSession("sess-old", 200);
    expect(found).toBeNull();
  });

  it("revokeSession marks the row revoked and findSession returns null", async () => {
    await harness.store.createIdentity({
      id: "ident-005",
      kind: "owner",
      displayName: "Eve",
      createdAt: 5000,
    });
    await harness.store.createSession({
      id: "sess-revoke",
      identityId: "ident-005",
      kind: "browser",
      createdAt: 1,
      lastSeenAt: 1,
      expiresAt: 9_999_999,
      rememberDevice: false,
      csrfSecret: "y",
      ip: null,
      userAgent: null,
      scopes: [],
    });
    await harness.store.revokeSession("sess-revoke", 5);
    const found = await harness.store.findSession("sess-revoke", 6);
    expect(found).toBeNull();
  });

  it("recordJtiSeen returns true for first insert and false on replay", async () => {
    const first = await harness.store.recordJtiSeen("jti-1", 1);
    expect(first).toBe(true);
    const replay = await harness.store.recordJtiSeen("jti-1", 2);
    expect(replay).toBe(false);
  });

  it("recordJtiSeen scopes per-jti so distinct ids both succeed", async () => {
    expect(await harness.store.recordJtiSeen("jti-a", 1)).toBe(true);
    expect(await harness.store.recordJtiSeen("jti-b", 2)).toBe(true);
  });

  it("appendAuditEvent persists the row and round-trips metadata", async () => {
    const event = await harness.store.appendAuditEvent({
      id: "audit-1",
      ts: 99,
      actorIdentityId: null,
      ip: null,
      userAgent: null,
      action: "auth.bootstrap.exchange",
      outcome: "success",
      metadata: { reason: "ok", attempt: 1, ok: true },
    });
    expect(event.action).toBe("auth.bootstrap.exchange");
    expect(event.metadata).toEqual({ reason: "ok", attempt: 1, ok: true });
  });

  it("createOwnerBinding enforces (connector, externalId, instanceId) uniqueness", async () => {
    await harness.store.createIdentity({
      id: "ident-bind",
      kind: "owner",
      displayName: "Frank",
      createdAt: 1,
    });
    await harness.store.createOwnerBinding({
      id: "bind-1",
      identityId: "ident-bind",
      connector: "discord",
      externalId: "111",
      displayHandle: "frank",
      instanceId: "eliza-A",
      verifiedAt: 2,
    });
    await expect(
      harness.store.createOwnerBinding({
        id: "bind-2",
        identityId: "ident-bind",
        connector: "discord",
        externalId: "111",
        displayHandle: "frank-dup",
        instanceId: "eliza-A",
        verifiedAt: 3,
      }),
    ).rejects.toThrow();
  });
});
