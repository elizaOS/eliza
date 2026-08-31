/**
 * Covers `handleAuthPairingCompatRoutes` — the device-pairing compat routes
 * (`GET /api/auth/pair-code`, owner-only `POST /api/auth/guest-pair-code`, and
 * public `POST /api/auth/pair`): the pair code is visible only to trusted-
 * loopback callers, the server-held code record fixes owner versus guest
 * authority regardless of client input, and a successful remote pair mints a
 * revocable machine session (returning the session id, never the static API
 * token). Harness mocks core logger/`stringToUuid`, the agent
 * config loader, shared loopback/token helpers, the `auth` module overrides,
 * the session and `AuthStore` layers, and first-run provisioning; drives
 * synthetic Node http request/response objects.
 */
import crypto from "node:crypto";
import * as http from "node:http";
import { Socket } from "node:net";
import {
  buildBrandEnvAliases,
  getBootConfig,
  setBootConfig,
} from "@elizaos/shared";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";

const mocks = vi.hoisted(() => ({
  loggerWarn: vi.fn(),
}));

vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    logger: {
      warn: mocks.loggerWarn,
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    },
    stringToUuid: (value: string) => value,
  };
});

vi.mock("@elizaos/agent", () => ({
  loadElizaConfig: () => ({ meta: {}, agents: {} }),
}));

vi.mock("@elizaos/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/shared")>();
  return {
    ...actual,
    isLoopbackBindHost: (host: string) => {
      const trimmed = host.trim().toLowerCase();
      let hostname = trimmed;
      try {
        hostname = new URL(`http://${trimmed}`).hostname.replace(
          /^\[|\]$/g,
          "",
        );
      } catch {
        hostname = trimmed.split(":")[0] ?? trimmed;
      }
      return (
        hostname === "localhost" ||
        hostname === "::1" ||
        hostname === "0:0:0:0:0:0:0:1" ||
        hostname.startsWith("127.")
      );
    },
    normalizeFirstRunProviderId: (value: unknown) =>
      typeof value === "string" ? value.trim().toLowerCase() : null,
    resolveApiToken: (env: NodeJS.ProcessEnv) =>
      env.ELIZA_API_TOKEN?.trim() || null,
    resolveDeploymentTargetInConfig: () => ({}),
    resolveServiceRoutingInConfig: () => ({}),
  };
});

const authOverrides = {
  ensureRouteAuthorized: vi.fn(async () => true),
  ensureRouteMinRole: vi.fn(async () => true),
  getCompatApiToken: () => process.env.ELIZA_API_TOKEN?.trim() || null,
  getProvidedApiToken: (req: Pick<http.IncomingMessage, "headers">) => {
    const header = req.headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    return value?.replace(/^Bearer\s+/i, "").trim() || null;
  },
  tokenMatches: (expected: string, provided: string) => expected === provided,
};

vi.mock("./auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth")>();
  return {
    ...actual,
    ...authOverrides,
  };
});

vi.mock("./auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth.ts")>();
  return {
    ...actual,
    ...authOverrides,
  };
});

interface MockAuthIdentity {
  id: string;
  kind: string;
  displayName: string;
  createdAt: number;
  passwordHash: string | null;
  cloudUserId: string | null;
}

const sessionMocks = vi.hoisted(() => ({
  createMachineSession: vi.fn(
    async (_store: unknown, _input: Record<string, unknown>) => ({
      session: {
        id: "test-machine-session-id",
        identityId: "test-identity-id",
        kind: "machine" as const,
        createdAt: 0,
        lastSeenAt: 0,
        expiresAt: 0,
        rememberDevice: false,
        csrfSecret: "csrf",
        ip: null,
        userAgent: null,
        scopes: [] as string[],
        revokedAt: null,
      },
      csrfToken: "csrf-token",
    }),
  ),
}));

vi.mock("./auth/sessions", () => ({
  findActiveSession: vi.fn(async (store, sessionId) => {
    const findSession = (
      store as { findSession?: (id: string) => Promise<unknown> }
    )?.findSession;
    return typeof findSession === "function"
      ? ((await findSession.call(store, sessionId)) ?? null)
      : null;
  }),
  parseSessionCookie: vi.fn(() => null),
  createMachineSession: sessionMocks.createMachineSession,
  denyOnAuthStoreError: () => () => null,
}));

const authStoreMocks = vi.hoisted(() => ({
  ctor: vi.fn(),
  listIdentitiesByKind: vi.fn(
    async (_kind: "owner" | "machine"): Promise<MockAuthIdentity[]> => [],
  ),
  findIdentityByDisplayName: vi.fn(
    async (): Promise<MockAuthIdentity | null> => null,
  ),
  createIdentity: vi.fn(
    async (input: { id: string; kind: string }): Promise<MockAuthIdentity> => ({
      id: input.id,
      kind: input.kind,
      displayName: "paired-device",
      createdAt: 0,
      passwordHash: null,
      cloudUserId: null,
    }),
  ),
}));

vi.mock("../services/auth-store", () => ({
  AuthStore: class MockAuthStore {
    constructor(...args: unknown[]) {
      authStoreMocks.ctor(...args);
    }
    listIdentitiesByKind = authStoreMocks.listIdentitiesByKind;
    findIdentityByDisplayName = authStoreMocks.findIdentityByDisplayName;
    createIdentity = authStoreMocks.createIdentity;
  },
}));

vi.mock("./server-first-run-helpers", () => ({
  isCloudProvisioned: () => process.env.ELIZA_CLOUD_PROVISIONED === "1",
}));

const STATE: CompatRuntimeState = {
  current: null,
  pendingAgentName: null,
  pendingRestartReasons: [],
};

// State that simulates a runtime with a backing AuthStore-capable adapter.
// The compat-route code reads `state.current?.adapter?.db`; presence of any
// non-null value is sufficient because the AuthStore is mocked above.
const STATE_WITH_DB: CompatRuntimeState = {
  current: { adapter: { db: {} } } as unknown as CompatRuntimeState["current"],
  pendingAgentName: null,
  pendingRestartReasons: [],
};

interface FakeRes {
  res: http.ServerResponse;
  body(): unknown;
  status(): number;
}

let handleAuthPairingCompatRoutes: typeof import("./auth-pairing-routes").handleAuthPairingCompatRoutes;
let resetAuthPairingStateForTests: typeof import("./auth-pairing-routes")._resetAuthPairingStateForTests;
let ensureAuthPairingCodeForRemoteAccess: typeof import("./auth-pairing-routes").ensureAuthPairingCodeForRemoteAccess;
let rotateAuthPairingInstanceForTests: typeof import("./auth-pairing-routes")._rotateAuthPairingInstanceForTests;

function fakeRes(): FakeRes {
  let bodyText = "";
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  res.statusCode = 200;
  res.setHeader = () => res;
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
  };
}

function fakeReq(opts: {
  method: string;
  pathname: string;
  ip?: string;
  host?: string;
  headers?: http.IncomingHttpHeaders;
}): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = opts.method;
  req.url = opts.pathname;
  req.headers = { host: opts.host ?? "example.com", ...(opts.headers ?? {}) };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: opts.ip ?? "203.0.113.10",
    configurable: true,
  });
  return req;
}

describe("auth pairing pair-code route", () => {
  const originalToken = process.env.ELIZA_API_TOKEN;
  const originalPairingDisabled = process.env.ELIZA_PAIRING_DISABLED;
  const originalCloudProvisioned = process.env.ELIZA_CLOUD_PROVISIONED;

  beforeAll(async () => {
    vi.resetModules();
    const routeModule = await import("./auth-pairing-routes");
    handleAuthPairingCompatRoutes = routeModule.handleAuthPairingCompatRoutes;
    resetAuthPairingStateForTests = routeModule._resetAuthPairingStateForTests;
    ensureAuthPairingCodeForRemoteAccess =
      routeModule.ensureAuthPairingCodeForRemoteAccess;
    rotateAuthPairingInstanceForTests =
      routeModule._rotateAuthPairingInstanceForTests;
  });

  beforeEach(() => {
    resetAuthPairingStateForTests();
    mocks.loggerWarn.mockReset();
    process.env.ELIZA_API_TOKEN = "pairing-test-token";
    delete process.env.ELIZA_PAIRING_DISABLED;
    delete process.env.ELIZA_CLOUD_PROVISIONED;
  });

  afterEach(() => {
    resetAuthPairingStateForTests();
    vi.restoreAllMocks();
    if (originalToken === undefined) delete process.env.ELIZA_API_TOKEN;
    else process.env.ELIZA_API_TOKEN = originalToken;
    if (originalPairingDisabled === undefined) {
      delete process.env.ELIZA_PAIRING_DISABLED;
    } else {
      process.env.ELIZA_PAIRING_DISABLED = originalPairingDisabled;
    }
    if (originalCloudProvisioned === undefined) {
      delete process.env.ELIZA_CLOUD_PROVISIONED;
    } else {
      process.env.ELIZA_CLOUD_PROVISIONED = originalCloudProvisioned;
    }
  });

  it("returns the current pair code to loopback callers", async () => {
    vi.spyOn(crypto, "randomInt").mockImplementation(() => 0);

    const res = fakeRes();
    await handleAuthPairingCompatRoutes(
      fakeReq({
        method: "GET",
        pathname: "/api/auth/pair-code",
        ip: "127.0.0.1",
        host: "localhost:2138",
      }),
      res.res,
      STATE,
    );

    expect(res.status()).toBe(200);
    expect(res.body()).toMatchObject({
      code: "AAAA-AAAA-AAAA",
      expiresAt: expect.any(Number),
      instanceId: expect.any(String),
    });
  });

  it("blocks remote and proxied remote callers", async () => {
    for (const req of [
      fakeReq({ method: "GET", pathname: "/api/auth/pair-code" }),
      fakeReq({
        method: "GET",
        pathname: "/api/auth/pair-code",
        ip: "127.0.0.1",
        host: "localhost:2138",
        headers: { "x-forwarded-for": "203.0.113.10" },
      }),
    ]) {
      const res = fakeRes();
      await handleAuthPairingCompatRoutes(req, res.res, STATE);

      expect(res.status()).toBe(403);
      expect(res.body()).toMatchObject({
        error: "Pair code visible on loopback only",
      });
    }
  });

  it("fails closed with a retryable 503 (never the static token) when the runtime DB is not ready, and keeps the code valid for retry (#13985)", async () => {
    vi.spyOn(crypto, "randomInt").mockImplementation(() => 0);
    sessionMocks.createMachineSession.mockClear();

    // Prime the in-memory pair code (it lives in module state, not the DB).
    await handleAuthPairingCompatRoutes(
      fakeReq({
        method: "GET",
        pathname: "/api/auth/pair-code",
        ip: "127.0.0.1",
        host: "localhost:2138",
      }),
      fakeRes().res,
      STATE,
    );

    // A remote device submits the correct code during the boot window, before
    // the runtime DB is up (STATE.current === null → getCompatDrizzleDb null).
    const remote = fakeReq({
      method: "POST",
      pathname: "/api/auth/pair",
      ip: "203.0.113.10",
    });
    (remote as unknown as { body: unknown }).body = {
      code: "AAAA-AAAA-AAAA",
      instanceId: ensureAuthPairingCodeForRemoteAccess()?.instanceId,
      access: "guest",
    };
    const res = fakeRes();
    await handleAuthPairingCompatRoutes(remote, res.res, STATE);

    // Fail closed: retryable 503, no session minted, and — critically — the
    // forever-valid static ELIZA_API_TOKEN is NEVER returned.
    expect(res.status()).toBe(503);
    expect(res.body()).toMatchObject({ code: "PAIRING_NOT_READY" });
    expect(sessionMocks.createMachineSession).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body())).not.toContain("pairing-test-token");

    // The 503 did NOT consume the code, so a retry once the DB is up completes
    // normally and mints a revocable session (not the static token).
    const retry = fakeReq({
      method: "POST",
      pathname: "/api/auth/pair",
      ip: "203.0.113.10",
    });
    (retry as unknown as { body: unknown }).body = {
      code: "AAAA-AAAA-AAAA",
      instanceId: ensureAuthPairingCodeForRemoteAccess()?.instanceId,
    };
    const res2 = fakeRes();
    await handleAuthPairingCompatRoutes(retry, res2.res, STATE_WITH_DB);
    expect(res2.status()).toBe(200);
    expect(res2.body()).toMatchObject({
      token: "test-machine-session-id",
      instanceId: expect.any(String),
    });
  });

  it("does not spend the invalid-code rate limit on valid no-DB retries", async () => {
    vi.spyOn(crypto, "randomInt").mockImplementation(() => 0);
    sessionMocks.createMachineSession.mockClear();

    await handleAuthPairingCompatRoutes(
      fakeReq({
        method: "GET",
        pathname: "/api/auth/pair-code",
        ip: "127.0.0.1",
        host: "localhost:2138",
      }),
      fakeRes().res,
      STATE,
    );

    for (let i = 0; i < 6; i += 1) {
      const retryDuringBoot = fakeReq({
        method: "POST",
        pathname: "/api/auth/pair",
        ip: "203.0.113.10",
      });
      (retryDuringBoot as unknown as { body: unknown }).body = {
        code: "AAAA-AAAA-AAAA",
        instanceId: ensureAuthPairingCodeForRemoteAccess()?.instanceId,
      };
      const res = fakeRes();
      await handleAuthPairingCompatRoutes(retryDuringBoot, res.res, STATE);
      expect(res.status()).toBe(503);
    }

    const retryAfterBoot = fakeReq({
      method: "POST",
      pathname: "/api/auth/pair",
      ip: "203.0.113.10",
    });
    (retryAfterBoot as unknown as { body: unknown }).body = {
      code: "AAAA-AAAA-AAAA",
      instanceId: ensureAuthPairingCodeForRemoteAccess()?.instanceId,
    };
    const res = fakeRes();
    await handleAuthPairingCompatRoutes(retryAfterBoot, res.res, STATE_WITH_DB);

    expect(res.status()).toBe(200);
    expect(res.body()).toMatchObject({
      token: "test-machine-session-id",
      instanceId: expect.any(String),
    });
    expect(sessionMocks.createMachineSession).toHaveBeenCalledTimes(1);
  });

  it("mints a machine session on successful pair (returns session id, not the static API token)", async () => {
    vi.spyOn(crypto, "randomInt").mockImplementation(() => 0);
    sessionMocks.createMachineSession.mockClear();
    authStoreMocks.listIdentitiesByKind.mockClear();
    authStoreMocks.findIdentityByDisplayName.mockClear();
    authStoreMocks.createIdentity.mockClear();

    // Prime the in-memory pair code via the loopback fetch.
    await handleAuthPairingCompatRoutes(
      fakeReq({
        method: "GET",
        pathname: "/api/auth/pair-code",
        ip: "127.0.0.1",
        host: "localhost:2138",
      }),
      fakeRes().res,
      STATE_WITH_DB,
    );

    const remote = fakeReq({
      method: "POST",
      pathname: "/api/auth/pair",
      ip: "203.0.113.10",
    });
    // `readCompatJsonBody` honours `req.body` when set (used by the runtime
    // plugin-route adapter), which lets us bypass the streaming path here.
    (remote as unknown as { body: unknown }).body = {
      code: "AAAA-AAAA-AAAA",
      instanceId: ensureAuthPairingCodeForRemoteAccess()?.instanceId,
    };

    const res = fakeRes();
    await handleAuthPairingCompatRoutes(remote, res.res, STATE_WITH_DB);

    expect(res.status()).toBe(200);
    expect(res.body()).toMatchObject({
      token: "test-machine-session-id",
      instanceId: expect.any(String),
    });
    expect(sessionMocks.createMachineSession).toHaveBeenCalledTimes(1);
    expect(authStoreMocks.createIdentity).toHaveBeenCalledTimes(1);
    expect(authStoreMocks.createIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "owner",
        displayName: "paired-device",
      }),
    );
    expect(sessionMocks.createMachineSession.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        identityId: expect.any(String),
        scopes: [],
        label: "paired-device",
        ip: "203.0.113.10",
      }),
    );
  });

  it("reuses an existing owner identity when one is configured", async () => {
    vi.spyOn(crypto, "randomInt").mockImplementation(() => 0);
    sessionMocks.createMachineSession.mockClear();
    authStoreMocks.createIdentity.mockClear();
    authStoreMocks.listIdentitiesByKind.mockImplementationOnce(async () => [
      {
        id: "owner-id",
        kind: "owner",
        displayName: "Operator",
        createdAt: 0,
        passwordHash: "hash",
        cloudUserId: null,
      },
    ]);

    await handleAuthPairingCompatRoutes(
      fakeReq({
        method: "GET",
        pathname: "/api/auth/pair-code",
        ip: "127.0.0.1",
        host: "localhost:2138",
      }),
      fakeRes().res,
      STATE_WITH_DB,
    );

    const remote = fakeReq({
      method: "POST",
      pathname: "/api/auth/pair",
      ip: "203.0.113.10",
    });
    (remote as unknown as { body: unknown }).body = {
      code: "AAAA-AAAA-AAAA",
      instanceId: ensureAuthPairingCodeForRemoteAccess()?.instanceId,
    };

    const res = fakeRes();
    await handleAuthPairingCompatRoutes(remote, res.res, STATE_WITH_DB);

    expect(res.status()).toBe(200);
    expect(res.body()).toMatchObject({ access: "owner" });
    expect(authStoreMocks.createIdentity).not.toHaveBeenCalled();
    expect(sessionMocks.createMachineSession.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ identityId: "owner-id" }),
    );
  });

  it("binds an owner-issued guest code to a fresh USER identity even if the client requests owner", async () => {
    vi.spyOn(crypto, "randomInt").mockImplementation(() => 0);
    sessionMocks.createMachineSession.mockClear();
    authStoreMocks.createIdentity.mockClear();
    authStoreMocks.listIdentitiesByKind.mockClear();

    const inviteRes = fakeRes();
    await handleAuthPairingCompatRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/guest-pair-code",
        ip: "127.0.0.1",
        host: "localhost:2138",
      }),
      inviteRes.res,
      STATE_WITH_DB,
    );
    expect(inviteRes.status()).toBe(201);
    const invite = inviteRes.body() as { code: string; instanceId: string };

    const remote = fakeReq({
      method: "POST",
      pathname: "/api/auth/pair",
      ip: "203.0.113.10",
    });
    (remote as unknown as { body: unknown }).body = {
      ...invite,
      access: "owner",
    };
    const res = fakeRes();
    await handleAuthPairingCompatRoutes(remote, res.res, STATE_WITH_DB);

    expect(res.status()).toBe(200);
    expect(res.body()).toMatchObject({
      token: "test-machine-session-id",
      identityId: expect.any(String),
      access: "guest",
    });
    expect(authStoreMocks.listIdentitiesByKind).not.toHaveBeenCalled();
    expect(authStoreMocks.createIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "machine",
        displayName: "paired-guest-device",
      }),
    );
    const identityId = (res.body() as { identityId: string }).identityId;
    expect(sessionMocks.createMachineSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ identityId }),
    );
  });

  it("returns a stable expired verdict and rotates the stale code", async () => {
    vi.spyOn(crypto, "randomInt").mockImplementation(() => 0);
    const issuedAt = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(issuedAt);
    const issued = ensureAuthPairingCodeForRemoteAccess();
    now.mockReturnValue(issuedAt + 60 * 60 * 1000 + 1);

    const req = fakeReq({
      method: "POST",
      pathname: "/api/auth/pair",
      ip: "203.0.113.10",
    });
    (req as unknown as { body: unknown }).body = {
      code: issued?.code,
      instanceId: issued?.instanceId,
    };
    const res = fakeRes();
    await handleAuthPairingCompatRoutes(req, res.res, STATE_WITH_DB);

    expect(res.status()).toBe(410);
    expect(res.body()).toMatchObject({
      code: "PAIRING_EXPIRED",
      instanceId: issued?.instanceId,
    });
    expect(ensureAuthPairingCodeForRemoteAccess()?.expiresAt).toBeGreaterThan(
      issued?.expiresAt ?? 0,
    );
  });

  it("burns an accepted code when session minting fails and reports that failure", async () => {
    const randomInt = vi.spyOn(crypto, "randomInt").mockImplementation(() => 0);
    sessionMocks.createMachineSession.mockRejectedValueOnce(
      new Error("database write failed"),
    );
    const issued = ensureAuthPairingCodeForRemoteAccess();
    const req = fakeReq({
      method: "POST",
      pathname: "/api/auth/pair",
      ip: "203.0.113.10",
    });
    (req as unknown as { body: unknown }).body = {
      code: issued?.code,
      instanceId: issued?.instanceId,
    };
    const res = fakeRes();
    await handleAuthPairingCompatRoutes(req, res.res, STATE_WITH_DB);

    expect(res.status()).toBe(500);
    expect(res.body()).toMatchObject({ code: "PAIRING_SESSION_FAILED" });

    randomInt.mockImplementation(() => 1);
    const replay = fakeReq({
      method: "POST",
      pathname: "/api/auth/pair",
      ip: "203.0.113.10",
    });
    (replay as unknown as { body: unknown }).body = {
      code: issued?.code,
      instanceId: issued?.instanceId,
    };
    const replayRes = fakeRes();
    await handleAuthPairingCompatRoutes(replay, replayRes.res, STATE_WITH_DB);
    expect(replayRes.status()).toBe(403);
    expect(replayRes.body()).toMatchObject({ code: "PAIRING_INVALID" });
  });

  it("does not reveal a code when pairing is disabled", async () => {
    process.env.ELIZA_PAIRING_DISABLED = "1";

    const res = fakeRes();
    await handleAuthPairingCompatRoutes(
      fakeReq({
        method: "GET",
        pathname: "/api/auth/pair-code",
        ip: "127.0.0.1",
        host: "localhost:2138",
      }),
      res.res,
      STATE,
    );

    expect(res.status()).toBe(503);
    expect(res.body()).toMatchObject({
      error: "Pairing not enabled",
      code: "PAIRING_DISABLED",
      instanceId: expect.any(String),
    });
  });

  it("rejects a code issued by a prior process instance after restart", async () => {
    vi.spyOn(crypto, "randomInt").mockImplementation(() => 0);
    sessionMocks.createMachineSession.mockClear();
    const issued = ensureAuthPairingCodeForRemoteAccess();
    expect(issued).not.toBeNull();
    const restartedInstanceId = rotateAuthPairingInstanceForTests();

    const req = fakeReq({
      method: "POST",
      pathname: "/api/auth/pair",
      ip: "203.0.113.10",
    });
    (req as unknown as { body: unknown }).body = {
      code: issued?.code,
      instanceId: issued?.instanceId,
    };
    const res = fakeRes();
    await handleAuthPairingCompatRoutes(req, res.res, STATE_WITH_DB);

    expect(res.status()).toBe(409);
    expect(res.body()).toMatchObject({
      code: "PAIRING_INSTANCE_MISMATCH",
      instanceId: restartedInstanceId,
    });
    expect(sessionMocks.createMachineSession).not.toHaveBeenCalled();
  });

  it("binds proxied submissions to the instance advertised by status", async () => {
    const statusReq = fakeReq({
      method: "GET",
      pathname: "/api/auth/status",
      ip: "127.0.0.1",
      headers: { "x-forwarded-for": "203.0.113.10" },
    });
    const statusRes = fakeRes();
    await handleAuthPairingCompatRoutes(
      statusReq,
      statusRes.res,
      STATE_WITH_DB,
    );
    const status = statusRes.body() as { instanceId: string };

    const pairReq = fakeReq({
      method: "POST",
      pathname: "/api/auth/pair",
      ip: "127.0.0.1",
      headers: { "x-forwarded-for": "203.0.113.10" },
    });
    (pairReq as unknown as { body: unknown }).body = {
      code: ensureAuthPairingCodeForRemoteAccess()?.code,
      instanceId: status.instanceId,
    };
    const pairRes = fakeRes();
    await handleAuthPairingCompatRoutes(pairReq, pairRes.res, STATE_WITH_DB);

    expect(pairRes.status()).toBe(200);
    expect(pairRes.body()).toMatchObject({ instanceId: status.instanceId });
  });

  // #13422: the pairing gate reads ELIZA_PAIRING_DISABLED through the
  // alias-aware reader, so a rebranded deployment's MILADY_PAIRING_DISABLED must
  // disable pairing WITHOUT the process.env alias-sync mirror mutation, and a
  // present canonical ELIZA_PAIRING_DISABLED must still win over the branded key.
  it("does not reveal a code when pairing is disabled via a branded (non-ELIZA) alias", async () => {
    const savedConfig = getBootConfig();
    const savedBranded = process.env.MILADY_PAIRING_DISABLED;
    setBootConfig({
      ...savedConfig,
      envAliases: buildBrandEnvAliases("MILADY"),
    });
    process.env.MILADY_PAIRING_DISABLED = "1";
    delete process.env.ELIZA_PAIRING_DISABLED;

    try {
      const res = fakeRes();
      await handleAuthPairingCompatRoutes(
        fakeReq({
          method: "GET",
          pathname: "/api/auth/pair-code",
          ip: "127.0.0.1",
          host: "localhost:2138",
        }),
        res.res,
        STATE,
      );

      expect(res.status()).toBe(503);
      expect(res.body()).toMatchObject({ error: "Pairing not enabled" });
      // Resolving the branded alias must never materialize the canonical mirror.
      expect(process.env.ELIZA_PAIRING_DISABLED).toBeUndefined();
    } finally {
      setBootConfig(savedConfig);
      if (savedBranded === undefined) {
        delete process.env.MILADY_PAIRING_DISABLED;
      } else {
        process.env.MILADY_PAIRING_DISABLED = savedBranded;
      }
    }
  });

  it("keeps a present canonical ELIZA_PAIRING_DISABLED ahead of the branded alias", async () => {
    const savedConfig = getBootConfig();
    const savedBranded = process.env.MILADY_PAIRING_DISABLED;
    setBootConfig({
      ...savedConfig,
      envAliases: buildBrandEnvAliases("MILADY"),
    });
    // Canonical present (and not "1") wins over a branded "1": pairing stays
    // ENABLED, proving the reader honors the ELIZA_* precedence contract.
    process.env.ELIZA_PAIRING_DISABLED = "0";
    process.env.MILADY_PAIRING_DISABLED = "1";

    try {
      vi.spyOn(crypto, "randomInt").mockImplementation(() => 0);
      const res = fakeRes();
      await handleAuthPairingCompatRoutes(
        fakeReq({
          method: "GET",
          pathname: "/api/auth/pair-code",
          ip: "127.0.0.1",
          host: "localhost:2138",
        }),
        res.res,
        STATE,
      );

      expect(res.status()).toBe(200);
      expect(res.body()).toMatchObject({ code: "AAAA-AAAA-AAAA" });
    } finally {
      setBootConfig(savedConfig);
      delete process.env.ELIZA_PAIRING_DISABLED;
      if (savedBranded === undefined) {
        delete process.env.MILADY_PAIRING_DISABLED;
      } else {
        process.env.MILADY_PAIRING_DISABLED = savedBranded;
      }
    }
  });
});
