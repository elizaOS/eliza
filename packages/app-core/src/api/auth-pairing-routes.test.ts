import crypto from "node:crypto";
import * as http from "node:http";
import { Socket } from "node:net";
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
    normalizeOnboardingProviderId: (value: unknown) =>
      typeof value === "string" ? value.trim().toLowerCase() : null,
    resolveApiToken: (env: NodeJS.ProcessEnv) =>
      env.ELIZA_API_TOKEN?.trim() || null,
    resolveDeploymentTargetInConfig: () => ({}),
    resolveServiceRoutingInConfig: () => ({}),
  };
});

const authOverrides = {
  ensureRouteAuthorized: vi.fn(async () => true),
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
  findActiveSession: vi.fn(async () => null),
  parseSessionCookie: vi.fn(() => null),
  createMachineSession: sessionMocks.createMachineSession,
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

vi.mock("./server-onboarding-helpers", () => ({
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
    (remote as unknown as { body: unknown }).body = { code: "AAAA-AAAA-AAAA" };

    const res = fakeRes();
    await handleAuthPairingCompatRoutes(remote, res.res, STATE_WITH_DB);

    expect(res.status()).toBe(200);
    expect(res.body()).toEqual({ token: "test-machine-session-id" });
    expect(sessionMocks.createMachineSession).toHaveBeenCalledTimes(1);
    expect(authStoreMocks.createIdentity).toHaveBeenCalledTimes(1);
    expect(authStoreMocks.createIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "machine",
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
    (remote as unknown as { body: unknown }).body = { code: "AAAA-AAAA-AAAA" };

    const res = fakeRes();
    await handleAuthPairingCompatRoutes(remote, res.res, STATE_WITH_DB);

    expect(res.status()).toBe(200);
    expect(authStoreMocks.createIdentity).not.toHaveBeenCalled();
    expect(sessionMocks.createMachineSession.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ identityId: "owner-id" }),
    );
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
    expect(res.body()).toMatchObject({ error: "Pairing not enabled" });
  });
});
