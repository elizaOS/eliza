/**
 * Real-listener integration for app-core's first-run compatibility pipeline.
 * Production auth policy, middleware, shared body cache, and canonical agent
 * handler run over TCP with real PGlite sessions; only runtime/DB leaf
 * collaborators are deterministic so commit and deferred-boot ordering is
 * directly observable.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { startApiServer as startApiServerType } from "@elizaos/agent";
import { __setConfigRenameSyncForTests } from "@elizaos/agent/config/config";
import { _resetAgentHostBridge } from "@elizaos/agent/runtime/host-bridge";
import { readRequestBodyBuffer, type UUID } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { installAgentHostBridge } from "../runtime/install-agent-host-bridge";
import { AuthStore, type DrizzleDatabase } from "../services/auth-store";
import {
  CSRF_HEADER_NAME,
  createBrowserSession,
  SESSION_COOKIE_NAME,
} from "./auth/sessions";
import { _resetAuthRateLimiter } from "./auth.ts";
import {
  registerDeferredRuntimeBoot,
  resetDeferredRuntimeBootForTests,
} from "./deferred-runtime-boot";
import { startApiServer } from "./server";

// The workspace fixture does not install plugin-openai's optional endpoint
// export; model-route startup only needs a deterministic URL resolver here.
vi.mock("@elizaos/plugin-openai/endpoint-config", () => ({
  resolveOpenAIBaseURL: () => "https://api.openai.com/v1",
}));

interface AdapterWithDb {
  db?: unknown;
  initialize?: () => Promise<void>;
  init?: () => Promise<void>;
  close?: () => Promise<void>;
}

interface SqlPluginModule {
  createDatabaseAdapter: (config: { dataDir: string }, id: UUID) => unknown;
  DatabaseMigrationService: new () => {
    initializeWithDatabase: (db: unknown) => Promise<void>;
    discoverAndRegisterPluginSchemas: (plugins: unknown[]) => void;
    runAllPluginMigrations: () => Promise<void>;
  };
  plugin: unknown;
}

const ENV_KEYS = [
  "ELIZA_API_BIND",
  "ELIZA_API_BIND_HOST",
  "ELIZA_API_TOKEN",
  "ELIZA_CONFIG_PATH",
  "ELIZA_DISABLE_AUTO_API_TOKEN",
  "ELIZA_PERSIST_CONFIG_PATH",
  "ELIZA_REQUIRE_LOCAL_AUTH",
  "ELIZA_STATE_DIR",
  "ELIZA_WALLET_AUTO_PROVISION",
  "EVM_PRIVATE_KEY",
  "SOLANA_PRIVATE_KEY",
] as const;

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
type ApiServer = Awaited<ReturnType<typeof startApiServerType>>;

let savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;
let stateDir = "";
let databaseDir = "";
let adapter: AdapterWithDb | null = null;
let server: ApiServer | null = null;
let baseUrl = "";
let ownerCookie = "";
let ownerCsrf = "";
let userCookie = "";
let userCsrf = "";
let upstreamBodies: Buffer[] = [];
let boot: ReturnType<typeof vi.fn<() => Promise<void>>>;

async function submit(
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/api/first-run`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

beforeAll(async () => {
  savedEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<(typeof ENV_KEYS)[number], string | undefined>;
  for (const key of ENV_KEYS) delete process.env[key];
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-first-run-wrapper-"));
  databaseDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-first-run-wrapper-db-"),
  );
  process.env.ELIZA_API_BIND = "127.0.0.1";
  process.env.ELIZA_API_BIND_HOST = "127.0.0.1";
  process.env.ELIZA_API_TOKEN = "configured-owner-token";
  process.env.ELIZA_DISABLE_AUTO_API_TOKEN = "1";
  process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_CONFIG_PATH = path.join(stateDir, "eliza.json");
  process.env.ELIZA_PERSIST_CONFIG_PATH = process.env.ELIZA_CONFIG_PATH;
  fs.writeFileSync(
    process.env.ELIZA_CONFIG_PATH,
    `${JSON.stringify({ logging: { level: "error" } }, null, 2)}\n`,
  );

  const {
    createDatabaseAdapter,
    DatabaseMigrationService,
    plugin: sqlPlugin,
  } = (await import("@elizaos/plugin-sql")) as SqlPluginModule;
  adapter = createDatabaseAdapter(
    { dataDir: databaseDir },
    AGENT_ID,
  ) as AdapterWithDb;
  if (typeof adapter.initialize === "function") await adapter.initialize();
  else if (typeof adapter.init === "function") await adapter.init();
  if (!adapter.db) throw new Error("wrapper harness adapter has no db");
  const migrations = new DatabaseMigrationService();
  await migrations.initializeWithDatabase(adapter.db);
  migrations.discoverAndRegisterPluginSchemas([sqlPlugin]);
  await migrations.runAllPluginMigrations();

  const store = new AuthStore(adapter.db as DrizzleDatabase);
  const owner = await store.createIdentity({
    id: "wrapper-owner",
    kind: "owner",
    displayName: "Owner",
    createdAt: Date.now(),
    passwordHash: null,
  });
  const user = await store.createIdentity({
    id: "wrapper-machine",
    kind: "machine",
    displayName: "Machine",
    createdAt: Date.now(),
    passwordHash: null,
  });
  const ownerSession = await createBrowserSession(store, {
    identityId: owner.id,
    ip: null,
    userAgent: "wrapper-test",
    rememberDevice: false,
  });
  const userSession = await createBrowserSession(store, {
    identityId: user.id,
    ip: null,
    userAgent: "wrapper-test",
    rememberDevice: false,
  });
  ownerCookie = `${SESSION_COOKIE_NAME}=${ownerSession.session.id}`;
  ownerCsrf = ownerSession.csrfToken;
  userCookie = `${SESSION_COOKIE_NAME}=${userSession.session.id}`;
  userCsrf = userSession.csrfToken;

  _resetAuthRateLimiter();
  installAgentHostBridge();
  resetDeferredRuntimeBootForTests();
  boot = vi.fn(async () => undefined);
  registerDeferredRuntimeBoot(boot);
  upstreamBodies = [];

  const storedAgent = {
    id: AGENT_ID,
    name: "Before",
    metadata: { character: { name: "Before" } },
  };
  const runtime = {
    adapter,
    agentId: AGENT_ID,
    character: { name: "Before" },
    getAgent: vi.fn(async () => structuredClone(storedAgent)),
    getService: vi.fn(() => null),
    registerEvent: vi.fn(),
    updateAgent: vi.fn(async () => true),
    deleteAgent: vi.fn(async () => true),
    reportError: vi.fn(),
  };
  server = await startApiServer({
    port: 0,
    runtime: runtime as never,
    skipDeferredStartupWork: true,
    requestMiddleware: async (req, _res, next) => {
      if (req.method === "POST" && req.url === "/api/first-run") {
        const body = await readRequestBodyBuffer(req);
        if (!body) throw new Error("accepted first-run body was unavailable");
        upstreamBodies.push(Buffer.from(body));
      }
      await next();
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
}, 120_000);

afterAll(async () => {
  __setConfigRenameSyncForTests(null);
  await server?.close();
  server = null;
  await adapter?.close?.();
  adapter = null;
  resetDeferredRuntimeBootForTests();
  _resetAuthRateLimiter();
  _resetAgentHostBridge();
  if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
  if (databaseDir) fs.rmSync(databaseDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}, 120_000);

describe.sequential("app-core canonical first-run wrapper", () => {
  it("denies malformed, oversized, USER, and bad-CSRF requests before upstream body access", async () => {
    const remoteAnonymous = await submit('{"name":"Ada"}', {
      "x-forwarded-for": "203.0.113.20",
    });
    expect(remoteAnonymous.status).toBe(401);

    const user = await submit('{"name":"Ada"}', {
      cookie: userCookie,
      [CSRF_HEADER_NAME]: userCsrf,
    });
    expect(user.status).toBe(403);

    const badCsrf = await submit('{"name":"Ada"}', {
      cookie: ownerCookie,
      [CSRF_HEADER_NAME]: "wrong-csrf",
    });
    expect(badCsrf.status).toBe(403);

    const malformed = await submit('{"name":}', {
      cookie: ownerCookie,
      [CSRF_HEADER_NAME]: ownerCsrf,
    });
    expect(malformed.status).toBe(400);

    const { MAX_FIRST_RUN_BODY_BYTES } = await import("./first-run-routes");
    const oversized = await submit("x".repeat(MAX_FIRST_RUN_BODY_BYTES + 1), {
      cookie: ownerCookie,
      [CSRF_HEADER_NAME]: ownerCsrf,
    });
    expect(oversized.status).toBe(413);
    expect(upstreamBodies).toEqual([]);
    expect(boot).not.toHaveBeenCalled();
  });

  it("replays exact OWNER bytes, withholds boot on failure, commits once, and rejects rerun", async () => {
    const body = '{\n  "name": "Ada",\n  "bio": ["  exact  "]\n}\n';
    __setConfigRenameSyncForTests(() => {
      const cause = new Error("config commit refused") as NodeJS.ErrnoException;
      cause.code = "EACCES";
      throw cause;
    });

    const failed = await submit(body, {
      cookie: ownerCookie,
      [CSRF_HEADER_NAME]: ownerCsrf,
    });
    expect(failed.status).toBe(503);
    expect(upstreamBodies).toEqual([Buffer.from(body)]);
    expect(boot).not.toHaveBeenCalled();

    __setConfigRenameSyncForTests(null);
    const [first, concurrent] = await Promise.all([
      submit(body, {
        cookie: ownerCookie,
        [CSRF_HEADER_NAME]: ownerCsrf,
      }),
      submit(body, {
        cookie: ownerCookie,
        [CSRF_HEADER_NAME]: ownerCsrf,
      }),
    ]);
    expect([first.status, concurrent.status].sort()).toEqual([200, 409]);
    expect(
      upstreamBodies.slice(1).every((bytes) => bytes.equals(Buffer.from(body))),
    ).toBe(true);
    await vi.waitFor(() => expect(boot).toHaveBeenCalledTimes(1));

    const bodyCount = upstreamBodies.length;
    const rerun = await submit('{"name":"Grace"}', {
      cookie: ownerCookie,
      [CSRF_HEADER_NAME]: ownerCsrf,
    });
    expect(rerun.status).toBe(409);
    expect(upstreamBodies).toHaveLength(bodyCount);
    expect(boot).toHaveBeenCalledTimes(1);
  });
});
