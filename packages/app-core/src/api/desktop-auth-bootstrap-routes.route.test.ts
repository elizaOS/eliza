/** Drives desktop bootstrap through a real migrated auth store and Unix socket. */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net, { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStore, type DrizzleDatabase } from "../services/auth-store";
import {
  DESKTOP_LOOPBACK_SESSION_SCOPE,
  ensureSessionForRequest,
} from "./auth/index";
import type { CompatRuntimeState } from "./compat-route-shared";
import { handleDesktopAuthBootstrapRoute } from "./desktop-auth-bootstrap-routes";

interface AdapterWithDb {
  db?: unknown;
  initialize?: () => Promise<void>;
  init?: () => Promise<void>;
  close?: () => Promise<void>;
}

interface SqlPluginModule {
  createDatabaseAdapter: (
    config: { dataDir: string },
    id: `${string}-${string}-${string}-${string}-${string}`,
  ) => unknown;
  DatabaseMigrationService: new () => {
    initializeWithDatabase: (db: unknown) => Promise<void>;
    discoverAndRegisterPluginSchemas: (plugins: unknown[]) => void;
    runAllPluginMigrations: () => Promise<void>;
  };
  plugin: unknown;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function openDatabase() {
  const {
    createDatabaseAdapter,
    DatabaseMigrationService,
    plugin: sqlPlugin,
  } = (await import("@elizaos/plugin-sql")) as SqlPluginModule;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-auth-db-"));
  const adapter = createDatabaseAdapter(
    { dataDir },
    "00000000-0000-0000-0000-000000000017",
  ) as AdapterWithDb;
  if (adapter.initialize) await adapter.initialize();
  else await adapter.init?.();
  if (!adapter.db) throw new Error("test adapter has no database");
  const db = adapter.db as DrizzleDatabase;
  const migrations = new DatabaseMigrationService();
  await migrations.initializeWithDatabase(db);
  migrations.discoverAndRegisterPluginSchemas([sqlPlugin]);
  await migrations.runAllPluginMigrations();
  cleanups.push(async () => {
    await adapter.close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { db, store: new AuthStore(db) };
}

async function openProofSocket() {
  const socketPath = path.join(
    os.tmpdir(),
    `mda-${crypto.randomBytes(4).toString("hex")}.sock`,
  );
  const server = net.createServer((connection) => {
    connection.end(crypto.randomBytes(32));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  fs.chmodSync(socketPath, 0o600);
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          fs.rmSync(socketPath, { force: true });
          if (error) reject(error);
          else resolve();
        });
      }),
  );
  return socketPath;
}

function request(options: {
  body?: unknown;
  cookie?: string;
  origin?: string;
  remoteAddress?: string;
  host?: string;
}): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = options.body === undefined ? "GET" : "POST";
  req.url =
    options.body === undefined ? "/api/auth/me" : "/api/auth/desktop-bootstrap";
  req.headers = {
    host: options.host ?? "127.0.0.1:31337",
    ...(options.cookie ? { cookie: options.cookie } : {}),
    ...(options.origin ? { origin: options.origin } : {}),
  };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: options.remoteAddress ?? "127.0.0.1",
    configurable: true,
  });
  if (options.body !== undefined) req.push(JSON.stringify(options.body));
  req.push(null);
  return req;
}

function response(req: http.IncomingMessage) {
  let body = "";
  const res = new http.ServerResponse(req);
  res.end = ((chunk?: string | Buffer) => {
    if (chunk) body += chunk.toString();
    return res;
  }) as typeof res.end;
  return { res, body: () => JSON.parse(body) as Record<string, unknown> };
}

describe("desktop auth bootstrap integration", () => {
  it("mints a loopback-marked session that cannot be replayed remotely", async () => {
    const { db, store } = await openDatabase();
    const socketPath = await openProofSocket();
    const req = request({ body: { socketPath } });
    const reply = response(req);
    const handled = await handleDesktopAuthBootstrapRoute(req, reply.res, {
      current: { adapter: { db } } as CompatRuntimeState["current"],
      pendingAgentName: null,
      pendingRestartReasons: [],
    });
    expect(handled).toBe(true);
    expect(reply.res.statusCode).toBe(200);
    const sessionId = String(reply.body().sessionId);
    const persisted = await store.findSession(sessionId, Date.now());
    expect(persisted?.scopes).toEqual([DESKTOP_LOOPBACK_SESSION_SCOPE]);

    const cookie = `eliza_session=${sessionId}`;
    const localReq = request({ cookie });
    await expect(
      ensureSessionForRequest(localReq, response(localReq).res, {
        store,
        allowBootstrapBearer: false,
      }),
    ).resolves.toMatchObject({ source: "cookie" });

    const remoteReq = request({
      cookie,
      remoteAddress: "203.0.113.18",
      host: "example.test",
    });
    await expect(
      ensureSessionForRequest(remoteReq, response(remoteReq).res, {
        store,
        allowBootstrapBearer: false,
      }),
    ).resolves.toBeNull();
  });

  it("forbids origin-bearing bootstrap requests before consuming proof", async () => {
    const { db } = await openDatabase();
    const socketPath = await openProofSocket();
    const req = request({
      body: { socketPath },
      origin: "http://127.0.0.1:5174",
    });
    const reply = response(req);
    await handleDesktopAuthBootstrapRoute(req, reply.res, {
      current: { adapter: { db } } as CompatRuntimeState["current"],
      pendingAgentName: null,
      pendingRestartReasons: [],
    });
    expect(reply.res.statusCode).toBe(403);
    expect(reply.body()).toMatchObject({
      error: "desktop_bootstrap_forbidden",
    });
  });
});
