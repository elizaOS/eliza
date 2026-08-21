/**
 * End-to-end coverage for the cookie/CORS authority split across the
 * agent → app-core host-bridge seam.
 *
 * The agent-side suite
 * (`packages/agent/src/api/server-cookie-cors-boundary.real-server.test.ts`)
 * drives real TCP but substitutes a deterministic `resolveHttpRequestAuthorization`,
 * so the cross-package plumbing this file covers — the real bridge installed by
 * `installAgentHostBridge()`, the real `resolveAuthorizedRouteRole`, and the
 * real session/CSRF cookie and header names — was previously only verified by
 * inspection. Sessions come from a real PGlite-backed `AuthStore`: an untrusted
 * origin must lose the ambient cookie while explicit bearer auth survives, and
 * cookie mutations must still present a valid CSRF token.
 */

import fs from "node:fs";
import * as http from "node:http";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  _resetAgentHostBridge,
  getAgentHostBridge,
} from "@elizaos/agent/runtime/host-bridge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createBrowserSession,
  createMachineSession,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from "../api/auth/sessions";
import { _resetAuthRateLimiter } from "../api/auth.ts";
import { AuthStore, type DrizzleDatabase } from "../services/auth-store";
import { installAgentHostBridge } from "./install-agent-host-bridge";

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

interface Harness {
  store: AuthStore;
  runtime: { adapter: { db: DrizzleDatabase } };
  cleanup: () => Promise<void>;
}

async function open(): Promise<Harness> {
  const {
    createDatabaseAdapter,
    DatabaseMigrationService,
    plugin: sqlPlugin,
  } = (await import("@elizaos/plugin-sql")) as SqlPluginModule;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-bridge-cors-"));
  const adapter = createDatabaseAdapter(
    { dataDir },
    "00000000-0000-0000-0000-000000000001",
  ) as AdapterWithDb;
  if (typeof adapter.initialize === "function") await adapter.initialize();
  else if (typeof adapter.init === "function") await adapter.init();
  if (!adapter.db) throw new Error("test harness: adapter has no .db");
  const db = adapter.db as DrizzleDatabase;
  const migrations = new DatabaseMigrationService();
  await migrations.initializeWithDatabase(db);
  migrations.discoverAndRegisterPluginSchemas([sqlPlugin]);
  await migrations.runAllPluginMigrations();
  return {
    store: new AuthStore(db),
    runtime: { adapter: { db } },
    cleanup: async () => {
      await adapter.close?.();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * A request that looks remote: `resolveAuthorizedRouteRole` short-circuits to
 * OWNER for trusted loopback callers, which would mask the cookie boundary.
 */
function request(
  method: string,
  headers: Record<string, string>,
): http.IncomingMessage {
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", { value: "203.0.113.10" });
  const req = new http.IncomingMessage(socket);
  req.method = method;
  for (const [name, value] of Object.entries(headers)) {
    req.headers[name.toLowerCase()] = value;
  }
  return req;
}

let harness: Harness | null = null;

beforeEach(async () => {
  _resetAuthRateLimiter();
  harness = await open();
  installAgentHostBridge();
}, 60_000);

afterEach(async () => {
  _resetAgentHostBridge();
  _resetAuthRateLimiter();
  await harness?.cleanup();
  harness = null;
});

describe("installed host bridge binds cookie auth to credentialed CORS trust", () => {
  async function resolve(
    method: string,
    headers: Record<string, string>,
    allowCookieAuth: boolean,
  ) {
    const bridge = getAgentHostBridge();
    if (!bridge.resolveHttpRequestAuthorization) {
      throw new Error("installed bridge exposes no authorization resolver");
    }
    return bridge.resolveHttpRequestAuthorization(
      request(method, headers),
      harness?.runtime as never,
      { allowCookieAuth },
    );
  }

  it("accepts a real session cookie only when the origin may carry credentials", async () => {
    if (!harness) throw new Error("harness");
    const identity = await harness.store.createIdentity({
      id: "owner-identity",
      kind: "owner",
      displayName: "Owner",
      createdAt: Date.now(),
      passwordHash: null,
    });
    const { session } = await createBrowserSession(harness.store, {
      identityId: identity.id,
    });
    const cookie = `${SESSION_COOKIE_NAME}=${session.id}`;

    await expect(resolve("GET", { cookie }, true)).resolves.toMatchObject({
      ok: true,
      role: "OWNER",
    });
    await expect(resolve("GET", { cookie }, false)).resolves.toMatchObject({
      ok: false,
      role: "NONE",
    });
  }, 60_000);

  it("keeps explicit bearer auth working from an untrusted origin", async () => {
    if (!harness) throw new Error("harness");
    const identity = await harness.store.createIdentity({
      id: "owner-identity",
      kind: "owner",
      displayName: "Owner",
      createdAt: Date.now(),
      passwordHash: null,
    });
    const { session } = await createMachineSession(harness.store, {
      identityId: identity.id,
      scopes: [],
    });

    await expect(
      resolve("GET", { authorization: `Bearer ${session.id}` }, false),
    ).resolves.toMatchObject({ ok: true, role: "OWNER" });
  }, 60_000);

  it("still requires a valid CSRF token for a trusted cookie mutation", async () => {
    if (!harness) throw new Error("harness");
    const identity = await harness.store.createIdentity({
      id: "owner-identity",
      kind: "owner",
      displayName: "Owner",
      createdAt: Date.now(),
      passwordHash: null,
    });
    const { session, csrfToken } = await createBrowserSession(harness.store, {
      identityId: identity.id,
    });
    const cookie = `${SESSION_COOKIE_NAME}=${session.id}`;

    await expect(resolve("POST", { cookie }, true)).resolves.toMatchObject({
      ok: false,
      role: "NONE",
    });
    await expect(
      resolve("POST", { cookie, [CSRF_HEADER_NAME]: "not-the-token" }, true),
    ).resolves.toMatchObject({ ok: false, role: "NONE" });
    await expect(
      resolve("POST", { cookie, [CSRF_HEADER_NAME]: csrfToken }, true),
    ).resolves.toMatchObject({ ok: true, role: "OWNER" });
  }, 60_000);
});
