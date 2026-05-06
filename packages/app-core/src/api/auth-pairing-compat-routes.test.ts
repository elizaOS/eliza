import crypto from "node:crypto";
import type http from "node:http";
import { Readable } from "node:stream";
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

vi.mock("@elizaos/core", () => ({
  logger: {
    warn: mocks.loggerWarn,
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
  stringToUuid: (value: string) => value,
}));

vi.mock("@elizaos/agent", () => ({
  loadElizaConfig: () => ({ meta: {}, agents: {} }),
}));

vi.mock("@elizaos/agent/config", () => ({
  loadElizaConfig: () => ({ meta: {}, agents: {} }),
}));

vi.mock("@elizaos/shared", () => ({
  isLoopbackBindHost: (host: string) => {
    const trimmed = host.trim().toLowerCase();
    let hostname = trimmed;
    try {
      hostname = new URL(`http://${trimmed}`).hostname.replace(/^\[|\]$/g, "");
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
}));

vi.mock("./auth", () => ({
  ensureRouteAuthorized: vi.fn(async () => true),
  getCompatApiToken: () => process.env.ELIZA_API_TOKEN?.trim() || null,
  getProvidedApiToken: (req: Pick<http.IncomingMessage, "headers">) => {
    const header = req.headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    return value?.replace(/^Bearer\s+/i, "").trim() || null;
  },
  tokenMatches: (expected: string, provided: string) => expected === provided,
}));

vi.mock("./auth/sessions", () => ({
  findActiveSession: vi.fn(async () => null),
  parseSessionCookie: vi.fn(() => null),
}));

vi.mock("./server-onboarding-compat", () => ({
  isCloudProvisioned: () => process.env.ELIZA_CLOUD_PROVISIONED === "1",
}));

const STATE: CompatRuntimeState = {
  current: null,
  pendingAgentName: null,
  pendingRestartReasons: [],
};

interface FakeRes {
  res: http.ServerResponse;
  body(): unknown;
  status(): number;
}

let handleAuthPairingCompatRoutes: typeof import("./auth-pairing-compat-routes").handleAuthPairingCompatRoutes;
let resetAuthPairingStateForTests: typeof import("./auth-pairing-compat-routes")._resetAuthPairingStateForTests;

function fakeRes(): FakeRes {
  let bodyText = "";
  const res = {
    headersSent: false,
    statusCode: 200,
    setHeader() {},
    end(chunk?: string | Buffer) {
      if (typeof chunk === "string") bodyText += chunk;
      else if (chunk) bodyText += chunk.toString("utf8");
    },
  } as unknown as http.ServerResponse;
  return {
    res,
    body() {
      return bodyText.length > 0 ? JSON.parse(bodyText) : null;
    },
    status() {
      return (res as unknown as { statusCode: number }).statusCode;
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
  const stream = Readable.from([]) as unknown as http.IncomingMessage;
  Object.assign(stream, {
    method: opts.method,
    url: opts.pathname,
    headers: { host: opts.host ?? "example.com", ...(opts.headers ?? {}) },
    socket: {
      remoteAddress: opts.ip ?? "203.0.113.10",
    },
  });
  return stream;
}

describe("auth pairing pair-code route", () => {
  const originalToken = process.env.ELIZA_API_TOKEN;
  const originalPairingDisabled = process.env.ELIZA_PAIRING_DISABLED;
  const originalCloudProvisioned = process.env.ELIZA_CLOUD_PROVISIONED;

  beforeAll(async () => {
    const routeModule = await import("./auth-pairing-compat-routes");
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
    vi.spyOn(crypto, "randomInt").mockReturnValue(0);

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
