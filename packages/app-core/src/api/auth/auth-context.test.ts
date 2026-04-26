/**
 * auth-context tests.
 *
 * Order of resolution: cookie → bearer-session → bearer-legacy → bearer-bootstrap.
 * Real pglite-backed store; no SQL mocks (project memory).
 */

import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  createDatabaseAdapter,
  DatabaseMigrationService,
  plugin as sqlPlugin,
} from "@elizaos/plugin-sql";
import type { DrizzleDatabase } from "@elizaos/plugin-sql/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore } from "../../services/auth-store";
import { _resetAuthRateLimiter } from "../auth";
import { ensureSessionForRequest } from "./auth-context";
import {
  _resetLegacyBearerState,
  LEGACY_DEPRECATION_HEADER,
} from "./legacy-bearer";
import { createBrowserSession, SESSION_COOKIE_NAME } from "./sessions";

interface AdapterWithDb {
  db?: unknown;
  initialize?: () => Promise<void>;
  init?: () => Promise<void>;
  close?: () => Promise<void>;
}

interface Harness {
  db: DrizzleDatabase;
  store: AuthStore;
  cleanup: () => Promise<void>;
}

async function open(): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "milady-authctx-"));
  const adapter = createDatabaseAdapter(
    { dataDir },
    "00000000-0000-0000-0000-000000000001" as `${string}-${string}-${string}-${string}-${string}`,
  ) as unknown as AdapterWithDb;
  if (typeof adapter.initialize === "function") await adapter.initialize();
  else if (typeof adapter.init === "function") await adapter.init();
  if (!adapter.db) throw new Error("test harness: adapter has no .db");
  const db = adapter.db as DrizzleDatabase;
  const migrations = new DatabaseMigrationService();
  await migrations.initializeWithDatabase(db);
  migrations.discoverAndRegisterPluginSchemas([sqlPlugin]);
  await migrations.runAllPluginMigrations();
  return {
    db,
    store: new AuthStore(db),
    cleanup: async () => {
      try {
        await adapter.close?.();
      } catch {
        // best effort
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function fakeReq(opts: {
  cookie?: string;
  bearer?: string;
  ip?: string;
  ua?: string;
}): Pick<http.IncomingMessage, "headers" | "socket"> {
  const headers: http.IncomingHttpHeaders = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.ua) headers["user-agent"] = opts.ua;
  return {
    headers,
    socket: {
      remoteAddress: opts.ip ?? "127.0.0.1",
    } as http.IncomingMessage["socket"],
  };
}

function fakeRes(): http.ServerResponse & { _headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const res = {
    headersSent: false,
    setHeader(name: string, value: string | string[]) {
      headers[name.toLowerCase()] = Array.isArray(value)
        ? value.join(", ")
        : value;
    },
    _headers: headers,
  } as unknown as http.ServerResponse & { _headers: Record<string, string> };
  return res;
}

describe("ensureSessionForRequest", () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await open();
    _resetLegacyBearerState();
    _resetAuthRateLimiter();
    delete process.env.ELIZA_API_TOKEN;
    delete process.env.MILADY_LEGACY_GRACE_UNTIL;
  });
  afterEach(async () => {
    await harness.cleanup();
    delete process.env.ELIZA_API_TOKEN;
    delete process.env.MILADY_LEGACY_GRACE_UNTIL;
  });

  it("resolves a session via the cookie path", async () => {
    await harness.store.createIdentity({
      id: "i1",
      kind: "owner",
      displayName: "alice",
      createdAt: 0,
    });
    const { session } = await createBrowserSession(harness.store, {
      identityId: "i1",
      ip: "127.0.0.1",
      userAgent: "vitest",
      rememberDevice: false,
    });
    const req = fakeReq({
      cookie: `${SESSION_COOKIE_NAME}=${session.id}`,
    });
    const res = fakeRes();
    const ctx = await ensureSessionForRequest(req, res, {
      store: harness.store,
    });
    expect(ctx).not.toBeNull();
    expect(ctx?.source).toBe("cookie");
    expect(ctx?.identity?.id).toBe("i1");
  });

  it("resolves a bearer session id when no cookie is set", async () => {
    await harness.store.createIdentity({
      id: "i2",
      kind: "owner",
      displayName: "bob",
      createdAt: 0,
    });
    const { session } = await createBrowserSession(harness.store, {
      identityId: "i2",
      ip: null,
      userAgent: null,
      rememberDevice: false,
    });
    const req = fakeReq({ bearer: session.id });
    const res = fakeRes();
    const ctx = await ensureSessionForRequest(req, res, {
      store: harness.store,
    });
    expect(ctx?.source).toBe("bearer-session");
  });

  it("emits the deprecation header when a valid legacy bearer is presented in-window", async () => {
    process.env.ELIZA_API_TOKEN = "legacy-token-value-1234567890";
    const req = fakeReq({ bearer: "legacy-token-value-1234567890" });
    const res = fakeRes();
    const ctx = await ensureSessionForRequest(req, res, {
      store: harness.store,
    });
    expect(ctx?.source).toBe("bearer-legacy");
    expect(ctx?.legacy).toBe(true);
    expect(res._headers[LEGACY_DEPRECATION_HEADER]).toBe("1");
  });

  it("rejects legacy bearer when grace window is past", async () => {
    process.env.ELIZA_API_TOKEN = "legacy-token-value-1234567890";
    process.env.MILADY_LEGACY_GRACE_UNTIL = "1"; // ms epoch in the past
    const req = fakeReq({ bearer: "legacy-token-value-1234567890" });
    const res = fakeRes();
    const ctx = await ensureSessionForRequest(req, res, {
      store: harness.store,
    });
    expect(ctx).toBeNull();
  });

  it("returns null for an invalid cookie + missing bearer", async () => {
    const req = fakeReq({
      cookie: `${SESSION_COOKIE_NAME}=garbage-no-such-id`,
    });
    const res = fakeRes();
    const ctx = await ensureSessionForRequest(req, res, {
      store: harness.store,
    });
    expect(ctx).toBeNull();
  });

  it("falls through to bearer-bootstrap when only a non-session bearer is present", async () => {
    const req = fakeReq({ bearer: "some-opaque-future-bootstrap-token" });
    const res = fakeRes();
    const ctx = await ensureSessionForRequest(req, res, {
      store: harness.store,
    });
    expect(ctx?.source).toBe("bearer-bootstrap");
  });

  it("rejects bootstrap bearer when allowBootstrapBearer is false", async () => {
    const req = fakeReq({ bearer: "any-thing" });
    const res = fakeRes();
    const ctx = await ensureSessionForRequest(req, res, {
      store: harness.store,
      allowBootstrapBearer: false,
    });
    expect(ctx).toBeNull();
  });

  it("rejects legacy bearer when allowLegacyBearer is false", async () => {
    process.env.ELIZA_API_TOKEN = "legacy-token-value-1234567890";
    const req = fakeReq({ bearer: "legacy-token-value-1234567890" });
    const res = fakeRes();
    const ctx = await ensureSessionForRequest(req, res, {
      store: harness.store,
      allowLegacyBearer: false,
      allowBootstrapBearer: false,
    });
    expect(ctx).toBeNull();
  });
});
