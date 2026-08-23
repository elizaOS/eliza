/**
 * Unit tests for `handleAuthBootstrapRoutes` and `BROWSER_SESSION_TTL_MS`.
 *
 * Drives the real route with synthetic `IncomingMessage`/`ServerResponse`
 * objects. Fail-closed branches (method/path, rate-limit, missing adapter
 * db, missing token, missing cloud env, verifier 401 mapping) use a dummy
 * drizzle handle because those paths never query. The minting path uses a
 * real pglite-backed `AuthStore`, a local JWKS server, and a jose-signed
 * RS256 bootstrap token so identity reuse, cookies, and TTL are observed
 * rather than stubbed.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import * as http from "node:http";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  exportJWK,
  generateKeyPair,
  type JWK,
  type KeyObject,
  SignJWT,
} from "jose";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { AuthStore, type DrizzleDatabase } from "../services/auth-store";
import {
  _resetSensitiveLimiters,
  CSRF_COOKIE_NAME,
  SENSITIVE_RATE_LIMIT_MAX,
  SESSION_COOKIE_NAME,
} from "./auth/index";
import {
  BROWSER_SESSION_TTL_MS,
  handleAuthBootstrapRoutes,
} from "./auth-bootstrap-routes";
import type { CompatRuntimeState } from "./compat-route-shared";

const EXCHANGE_PATH = "/api/auth/bootstrap/exchange";
const ISSUER_HOST = "127.0.0.1";
const CONTAINER_ID = "container-unit-auth-bootstrap";

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

interface FakeRes {
  res: http.ServerResponse;
  body(): unknown;
  status(): number;
  cookies(): string[];
}

function fakeRes(): FakeRes {
  let bodyText = "";
  const cookies: string[] = [];
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  res.statusCode = 200;
  res.setHeader = (name: string, value: number | string | string[]) => {
    if (name.toLowerCase() === "set-cookie") {
      if (Array.isArray(value)) cookies.push(...value.map(String));
      else cookies.push(String(value));
    }
    return res;
  };
  res.end = ((chunk?: string | Buffer) => {
    if (typeof chunk === "string") bodyText += chunk;
    else if (chunk) bodyText += chunk.toString("utf8");
    return res;
  }) as typeof res.end;
  return {
    res,
    body() {
      return bodyText.length > 0 ? JSON.parse(bodyText) : null;
    },
    status() {
      return res.statusCode;
    },
    cookies() {
      return cookies;
    },
  };
}

function fakeReq(opts: {
  method?: string | undefined;
  pathname?: string;
  body?: unknown;
  ip?: string | null;
  userAgent?: string | string[];
}): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  if (opts.method !== undefined) req.method = opts.method;
  req.url = opts.pathname ?? EXCHANGE_PATH;
  const headers: http.IncomingHttpHeaders = { host: "localhost:2138" };
  if (opts.userAgent !== undefined) {
    // Node accepts string[] here; IncomingHttpHeaders types user-agent as string.
    (headers as { "user-agent"?: string | string[] })["user-agent"] =
      opts.userAgent;
  }
  req.headers = headers;
  if (opts.body !== undefined) {
    (req as http.IncomingMessage & { body?: unknown }).body = opts.body;
  }
  Object.defineProperty(req.socket, "remoteAddress", {
    value: opts.ip === undefined ? "127.0.0.1" : opts.ip,
    configurable: true,
  });
  return req;
}

function streamingReq(
  raw: string,
  pathname = EXCHANGE_PATH,
): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = "POST";
  req.url = pathname;
  req.headers = { host: "localhost:2138", "content-type": "application/json" };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: "127.0.0.1",
    configurable: true,
  });
  req.push(Buffer.from(raw));
  req.push(null);
  return req;
}

function dummyState(): CompatRuntimeState {
  return {
    current: {
      adapter: { db: {} },
    } as CompatRuntimeState["current"],
    pendingAgentName: null,
    pendingRestartReasons: [],
  };
}

function stateWithRuntime(current: unknown): CompatRuntimeState {
  return {
    current: current as CompatRuntimeState["current"],
    pendingAgentName: null,
    pendingRestartReasons: [],
  };
}

function deriveIdentityIdFromCloudUser(cloudUserId: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(cloudUserId, "utf8")
    .digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}

function asJoseKeyObject(key: unknown): KeyObject {
  if (!key || typeof key !== "object") {
    throw new Error("Expected jose to return a KeyObject");
  }
  return key as KeyObject;
}

const ENV_KEYS = [
  "ELIZA_CLOUD_ISSUER",
  "ELIZA_CLOUD_CONTAINER_ID",
  "ELIZA_STATE_DIR",
] as const;

const originalEnv: Record<(typeof ENV_KEYS)[number], string | undefined> =
  Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
    (typeof ENV_KEYS)[number],
    string | undefined
  >;

let stateDir: string;

beforeAll(() => {
  stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-auth-bootstrap-unit-"),
  );
});

afterAll(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

beforeEach(() => {
  _resetSensitiveLimiters();
  process.env.ELIZA_STATE_DIR = stateDir;
  delete process.env.ELIZA_CLOUD_ISSUER;
  delete process.env.ELIZA_CLOUD_CONTAINER_ID;
});

afterEach(() => {
  _resetSensitiveLimiters();
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("BROWSER_SESSION_TTL_MS", () => {
  it("is a 12-hour sliding window in milliseconds", () => {
    expect(BROWSER_SESSION_TTL_MS).toBe(12 * 60 * 60 * 1000);
  });
});

describe("handleAuthBootstrapRoutes", () => {
  it("returns false for a non-POST method, including a missing method (defaults to GET)", async () => {
    const getRes = fakeRes();
    await expect(
      handleAuthBootstrapRoutes(
        fakeReq({ method: "GET" }),
        getRes.res,
        dummyState(),
      ),
    ).resolves.toBe(false);
    expect(getRes.status()).toBe(200);
    expect(getRes.body()).toBeNull();

    const putRes = fakeRes();
    await expect(
      handleAuthBootstrapRoutes(
        fakeReq({ method: "PUT" }),
        putRes.res,
        dummyState(),
      ),
    ).resolves.toBe(false);

    const missingMethod = fakeRes();
    await expect(
      handleAuthBootstrapRoutes(
        fakeReq({ method: undefined }),
        missingMethod.res,
        dummyState(),
      ),
    ).resolves.toBe(false);

    const lowerPost = fakeRes();
    await expect(
      handleAuthBootstrapRoutes(
        fakeReq({ method: "post", body: {} }),
        lowerPost.res,
        dummyState(),
      ),
    ).resolves.toBe(true);
  });

  it("returns false for a path other than POST /api/auth/bootstrap/exchange", async () => {
    const other = fakeRes();
    await expect(
      handleAuthBootstrapRoutes(
        fakeReq({ method: "POST", pathname: "/api/auth/login" }),
        other.res,
        dummyState(),
      ),
    ).resolves.toBe(false);

    const trailing = fakeRes();
    await expect(
      handleAuthBootstrapRoutes(
        fakeReq({ method: "POST", pathname: `${EXCHANGE_PATH}/` }),
        trailing.res,
        dummyState(),
      ),
    ).resolves.toBe(false);

    const query = fakeRes();
    await expect(
      handleAuthBootstrapRoutes(
        fakeReq({
          method: "POST",
          pathname: `${EXCHANGE_PATH}?x=1`,
          body: {},
        }),
        query.res,
        dummyState(),
      ),
    ).resolves.toBe(true);
  });

  it("returns 429 once the per-IP bootstrap exchange limiter is exhausted", async () => {
    const ip = "203.0.113.50";
    for (let i = 0; i < SENSITIVE_RATE_LIMIT_MAX; i += 1) {
      const allowed = fakeRes();
      const handled = await handleAuthBootstrapRoutes(
        fakeReq({ method: "POST", body: {}, ip }),
        allowed.res,
        dummyState(),
      );
      expect(handled).toBe(true);
      expect(allowed.status()).not.toBe(429);
    }

    const blocked = fakeRes();
    const handled = await handleAuthBootstrapRoutes(
      fakeReq({ method: "POST", body: {}, ip }),
      blocked.res,
      dummyState(),
    );
    expect(handled).toBe(true);
    expect(blocked.status()).toBe(429);
    expect(blocked.body()).toEqual({
      error: "rate_limited",
      reason: "rate_limited",
    });
  });

  it("buckets a null remoteAddress under the shared unknown limiter", async () => {
    for (let i = 0; i < SENSITIVE_RATE_LIMIT_MAX; i += 1) {
      const allowed = fakeRes();
      await handleAuthBootstrapRoutes(
        fakeReq({ method: "POST", body: {}, ip: null }),
        allowed.res,
        dummyState(),
      );
      expect(allowed.status()).not.toBe(429);
    }
    const blocked = fakeRes();
    await handleAuthBootstrapRoutes(
      fakeReq({ method: "POST", body: {}, ip: null }),
      blocked.res,
      dummyState(),
    );
    expect(blocked.status()).toBe(429);
  });

  it("returns 503 db_unavailable when the runtime, adapter, or drizzle handle is missing", async () => {
    const cases: CompatRuntimeState[] = [
      stateWithRuntime(null),
      stateWithRuntime({}),
      stateWithRuntime({ adapter: {} }),
      stateWithRuntime({ adapter: { db: undefined } }),
    ];
    for (const state of cases) {
      const res = fakeRes();
      const handled = await handleAuthBootstrapRoutes(
        fakeReq({ method: "POST", body: { token: "not-used" } }),
        res.res,
        state,
      );
      expect(handled).toBe(true);
      expect(res.status()).toBe(503);
      expect(res.body()).toEqual({
        error: "db_unavailable",
        reason: "db_unavailable",
      });
    }
  });

  it("returns 400 missing_token for a missing, blank, or non-string token", async () => {
    const payloads: unknown[] = [
      {},
      { token: "" },
      { token: "   " },
      { token: 12 },
      { token: null },
      { token: { nested: true } },
    ];
    for (const body of payloads) {
      _resetSensitiveLimiters();
      const res = fakeRes();
      const handled = await handleAuthBootstrapRoutes(
        fakeReq({ method: "POST", body }),
        res.res,
        dummyState(),
      );
      expect(handled).toBe(true);
      expect(res.status()).toBe(400);
      expect(res.body()).toEqual({ error: "missing_token" });
    }
  });

  it("maps a present-but-too-short token to 400 auth_required / missing_token", async () => {
    process.env.ELIZA_CLOUD_ISSUER = "https://cloud.example";
    process.env.ELIZA_CLOUD_CONTAINER_ID = CONTAINER_ID;
    const res = fakeRes();
    const handled = await handleAuthBootstrapRoutes(
      fakeReq({ method: "POST", body: { token: "abcdefg" } }),
      res.res,
      dummyState(),
    );
    expect(handled).toBe(true);
    expect(res.status()).toBe(400);
    expect(res.body()).toEqual({
      error: "auth_required",
      reason: "missing_token",
    });
  });

  it("returns 503 when the cloud issuer env is missing or whitespace", async () => {
    process.env.ELIZA_CLOUD_ISSUER = "  ";
    process.env.ELIZA_CLOUD_CONTAINER_ID = CONTAINER_ID;
    const res = fakeRes();
    const handled = await handleAuthBootstrapRoutes(
      fakeReq({ method: "POST", body: { token: "abcdefgh" } }),
      res.res,
      dummyState(),
    );
    expect(handled).toBe(true);
    expect(res.status()).toBe(503);
    expect(res.body()).toEqual({
      error: "auth_required",
      reason: "missing_issuer_env",
    });
  });

  it("returns 503 when the cloud container env is missing", async () => {
    process.env.ELIZA_CLOUD_ISSUER = "https://cloud.example";
    delete process.env.ELIZA_CLOUD_CONTAINER_ID;
    const res = fakeRes();
    const handled = await handleAuthBootstrapRoutes(
      fakeReq({ method: "POST", body: { token: "abcdefgh" } }),
      res.res,
      dummyState(),
    );
    expect(handled).toBe(true);
    expect(res.status()).toBe(503);
    expect(res.body()).toEqual({
      error: "auth_required",
      reason: "missing_container_env",
    });
  });

  it("maps a JWKS fetch failure to 401 auth_required / jwks_fetch_failed", async () => {
    process.env.ELIZA_CLOUD_ISSUER = "http://127.0.0.1:1";
    process.env.ELIZA_CLOUD_CONTAINER_ID = CONTAINER_ID;
    const res = fakeRes();
    const handled = await handleAuthBootstrapRoutes(
      fakeReq({ method: "POST", body: { token: "abcdefgh" } }),
      res.res,
      dummyState(),
    );
    expect(handled).toBe(true);
    expect(res.status()).toBe(401);
    expect(res.body()).toEqual({
      error: "auth_required",
      reason: "jwks_fetch_failed",
    });
  });

  it("returns 400 Invalid JSON body when the request stream is not a JSON object", async () => {
    const invalid = fakeRes();
    const handledInvalid = await handleAuthBootstrapRoutes(
      streamingReq("not-json"),
      invalid.res,
      dummyState(),
    );
    expect(handledInvalid).toBe(true);
    expect(invalid.status()).toBe(400);
    expect(invalid.body()).toEqual({ error: "Invalid JSON body" });

    const arrayBody = fakeRes();
    const handledArray = await handleAuthBootstrapRoutes(
      streamingReq("[1]"),
      arrayBody.res,
      dummyState(),
    );
    expect(handledArray).toBe(true);
    expect(arrayBody.status()).toBe(400);
    expect(arrayBody.body()).toEqual({ error: "Invalid JSON body" });
  });
});

describe("handleAuthBootstrapRoutes minting (real pglite + JWKS)", () => {
  const HARNESS_HOOK_TIMEOUT_MS = 120_000;

  let privateKey: KeyObject;
  let issuer: string;
  let closeJwks: () => Promise<void>;
  let dataDir: string;
  let adapter: AdapterWithDb;
  let db: DrizzleDatabase;
  let store: AuthStore;
  let state: CompatRuntimeState;

  async function mint(
    overrides: {
      sub?: string;
      jti?: string;
      containerId?: string;
      iss?: string;
    } = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      sub: overrides.sub ?? "cloud-user-unit-1",
      containerId: overrides.containerId ?? CONTAINER_ID,
      scope: "bootstrap",
      jti: overrides.jti ?? `jti-${crypto.randomBytes(8).toString("hex")}`,
    })
      .setProtectedHeader({ alg: "RS256", kid: "unit-key" })
      .setIssuer(overrides.iss ?? issuer)
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(privateKey);
  }

  beforeAll(async () => {
    const real = await generateKeyPair("RS256", { extractable: true });
    privateKey = asJoseKeyObject(real.privateKey);
    const publicJwk = await exportJWK(real.publicKey);
    publicJwk.kid = "unit-key";
    publicJwk.alg = "RS256";
    publicJwk.use = "sig";
    const jwksBody = JSON.stringify({ keys: [publicJwk] satisfies JWK[] });
    const server = http.createServer((req, res) => {
      if (req.url?.endsWith("/.well-known/jwks.json")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(jwksBody);
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, ISSUER_HOST, () => resolve());
    });
    const address = server.address();
    if (!address || typeof address !== "object") {
      throw new Error("JWKS server did not bind");
    }
    issuer = `http://${ISSUER_HOST}:${address.port}`;
    closeJwks = () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
  }, HARNESS_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await closeJwks();
  });

  beforeEach(async () => {
    const {
      createDatabaseAdapter,
      DatabaseMigrationService,
      plugin: sqlPlugin,
    } = (await import("@elizaos/plugin-sql")) as SqlPluginModule;
    dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-auth-bootstrap-pg-"),
    );
    adapter = createDatabaseAdapter(
      { dataDir },
      "00000000-0000-0000-0000-000000000042" as `${string}-${string}-${string}-${string}-${string}`,
    ) as AdapterWithDb;
    if (typeof adapter.initialize === "function") await adapter.initialize();
    else if (typeof adapter.init === "function") await adapter.init();
    if (!adapter.db) throw new Error("test harness: adapter has no .db");
    db = adapter.db as DrizzleDatabase;
    const migrations = new DatabaseMigrationService();
    await migrations.initializeWithDatabase(db);
    migrations.discoverAndRegisterPluginSchemas([sqlPlugin]);
    await migrations.runAllPluginMigrations();
    store = new AuthStore(db);
    state = {
      current: { adapter: { db } } as CompatRuntimeState["current"],
      pendingAgentName: null,
      pendingRestartReasons: [],
    };
    process.env.ELIZA_CLOUD_ISSUER = issuer;
    process.env.ELIZA_CLOUD_CONTAINER_ID = CONTAINER_ID;
    process.env.ELIZA_STATE_DIR = stateDir;
    _resetSensitiveLimiters();
  }, HARNESS_HOOK_TIMEOUT_MS);

  afterEach(async () => {
    await adapter.close?.().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("mints a 12h browser session, cookies, and a stable cloud-user identity", async () => {
    const sub = "cloud-user-unit-mint";
    const token = await mint({ sub });
    const before = Date.now();
    const res = fakeRes();
    const handled = await handleAuthBootstrapRoutes(
      fakeReq({
        method: "POST",
        body: { token: `  ${token}  ` },
        userAgent: ["ElizaUnit/1.0", "ignored"],
      }),
      res.res,
      state,
    );
    const after = Date.now();
    expect(handled).toBe(true);
    expect(res.status()).toBe(200);
    const body = res.body() as {
      sessionId: string;
      identityId: string;
      expiresAt: number;
    };
    expect(body.sessionId).toMatch(/^[0-9a-f]{64}$/);
    expect(body.identityId).toBe(deriveIdentityIdFromCloudUser(sub));
    expect(body.expiresAt).toBeGreaterThanOrEqual(
      before + BROWSER_SESSION_TTL_MS,
    );
    expect(body.expiresAt).toBeLessThanOrEqual(after + BROWSER_SESSION_TTL_MS);
    expect(
      res.cookies().some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`)),
    ).toBe(true);
    expect(
      res.cookies().some((c) => c.startsWith(`${CSRF_COOKIE_NAME}=`)),
    ).toBe(true);

    const identity = await store.findIdentity(body.identityId);
    expect(identity).not.toBeNull();
    expect(identity?.kind).toBe("owner");
    expect(identity?.cloudUserId).toBe(sub);
    expect(identity?.displayName).toBe(`Cloud user ${sub.slice(0, 8)}`);
    expect(identity?.passwordHash).toBeNull();
  });

  it("reuses the existing identity row for a second exchange by the same cloud user", async () => {
    const sub = "cloud-user-unit-reuse";
    const first = fakeRes();
    await handleAuthBootstrapRoutes(
      fakeReq({ method: "POST", body: { token: await mint({ sub }) } }),
      first.res,
      state,
    );
    expect(first.status()).toBe(200);
    const firstBody = first.body() as { identityId: string; sessionId: string };

    const second = fakeRes();
    await handleAuthBootstrapRoutes(
      fakeReq({ method: "POST", body: { token: await mint({ sub }) } }),
      second.res,
      state,
    );
    expect(second.status()).toBe(200);
    const secondBody = second.body() as {
      identityId: string;
      sessionId: string;
    };
    expect(secondBody.identityId).toBe(firstBody.identityId);
    expect(secondBody.sessionId).not.toBe(firstBody.sessionId);

    const owners = await store.listIdentitiesByKind("owner");
    expect(owners.filter((row) => row.cloudUserId === sub)).toHaveLength(1);
  });

  it("rejects a replayed jti with 401 reason=replay", async () => {
    const token = await mint({ sub: "cloud-user-unit-replay" });
    const first = fakeRes();
    await handleAuthBootstrapRoutes(
      fakeReq({ method: "POST", body: { token } }),
      first.res,
      state,
    );
    expect(first.status()).toBe(200);

    const replay = fakeRes();
    const handled = await handleAuthBootstrapRoutes(
      fakeReq({ method: "POST", body: { token } }),
      replay.res,
      state,
    );
    expect(handled).toBe(true);
    expect(replay.status()).toBe(401);
    expect(replay.body()).toEqual({
      error: "auth_required",
      reason: "replay",
    });
  });

  it("rejects a token whose containerId does not match the env", async () => {
    const token = await mint({
      sub: "cloud-user-unit-container",
      containerId: "container-other",
    });
    const res = fakeRes();
    const handled = await handleAuthBootstrapRoutes(
      fakeReq({ method: "POST", body: { token } }),
      res.res,
      state,
    );
    expect(handled).toBe(true);
    expect(res.status()).toBe(401);
    expect(res.body()).toEqual({
      error: "auth_required",
      reason: "container_mismatch",
    });
  });
});
