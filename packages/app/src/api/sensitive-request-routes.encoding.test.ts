/** Exercises malformed sensitive-request identifiers with policy and delivery mocked. */
import * as http from "node:http";
import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  defaultSensitiveRequestPolicy: () => ({
    actor: "owner_or_linked_identity",
    requirePrivateDelivery: true,
    requireAuthenticatedLink: true,
    allowInlineOwnerAppEntry: true,
    allowPublicLink: false,
    allowDmFallback: true,
    allowTunnelLink: true,
    allowCloudLink: true,
  }),
  getTunnelService: () => null,
  resolveSensitiveRequestDelivery: () => ({
    mode: "dm_or_owner_app_instruction",
    source: "api",
    authenticated: false,
    publicLinkAllowed: false,
    instruction: "Ask the owner to use a DM or the owner app.",
  }),
  redactSensitiveRequestMetadata: (value: unknown) => value,
}));

vi.mock("../services/vault-mirror", () => ({
  sharedVault: () => ({ set: vi.fn() }),
}));

vi.mock("./auth.ts", () => ({
  ensureRouteAuthorized: vi.fn(async () => true),
  getCompatApiToken: () => undefined,
  getProvidedApiToken: () => undefined,
  tokenMatches: () => false,
}));

vi.mock("./compat-route-shared", () => ({
  isTrustedLocalRequest: () => true,
  readCompatJsonBody: async (req: { body?: unknown }) => req.body ?? {},
}));

import type { CompatRuntimeState } from "./compat-route-shared";
import { handleSensitiveRequestRoutes } from "./sensitive-request-routes";
import { LocalSensitiveRequestStore } from "./sensitive-request-store";

const STATE: CompatRuntimeState = {
  current: null,
  pendingAgentName: null,
  pendingRestartReasons: [],
};

function fakeRes(): {
  res: http.ServerResponse;
  body: () => unknown;
  status: () => number;
} {
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
    body: () => (bodyText.length > 0 ? JSON.parse(bodyText) : null),
    status: () => res.statusCode,
  };
}

function fakeReq(method: string, pathname: string): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = method;
  req.url = pathname;
  req.headers = { host: "localhost:2138" };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: "127.0.0.1",
    configurable: true,
  });
  return req;
}

async function call(
  method: string,
  pathname: string,
  store = new LocalSensitiveRequestStore(),
) {
  const captured = fakeRes();
  const handled = await handleSensitiveRequestRoutes(
    fakeReq(method, pathname),
    captured.res,
    STATE,
    { store, now: () => Date.parse("2026-05-10T12:00:00.000Z") },
  );
  return { handled, status: captured.status(), body: captured.body() };
}

describe("GET /api/sensitive-requests/:id encoding", () => {
  it("POST collection create is untouched", async () => {
    const captured = fakeRes();
    const req = fakeReq("POST", "/api/sensitive-requests");
    (req as { body?: unknown }).body = {
      kind: "secret",
      agentId: "agent-local",
      source: "public",
      target: { kind: "secret", key: "OPENAI_API_KEY" },
    };
    const handled = await handleSensitiveRequestRoutes(
      req,
      captured.res,
      STATE,
      {
        store: new LocalSensitiveRequestStore(),
        now: () => Date.parse("2026-05-10T12:00:00.000Z"),
      },
    );
    expect(handled).toBe(true);
    expect(captured.status()).toBe(201);
    expect(captured.body()).toEqual(
      expect.objectContaining({ ok: true, submitToken: expect.any(String) }),
    );
  });

  it("canonical id still 404s as not found", async () => {
    const result = await call("GET", "/api/sensitive-requests/ghost-id");
    expect(result.handled).toBe(true);
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: "not found" });
  });

  it("canonical percent-encoded hyphen still decodes before the 404", async () => {
    const result = await call("GET", "/api/sensitive-requests/ghost%2Did");
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: "not found" });
  });

  it.each(["%", "%2", "%ZZ", "%E0%A4"])(
    "rejects malformed get id %s with 400",
    async (token) => {
      const result = await call("GET", `/api/sensitive-requests/${token}`);
      expect(result.handled).toBe(true);
      expect(result.status).toBe(400);
      expect(result.body).toEqual({
        error: "Invalid request id: malformed URL encoding",
      });
    },
  );
});

describe("POST /api/sensitive-requests/:id submit/cancel encoding", () => {
  it.each(["%", "%2", "%ZZ"])(
    "rejects malformed submit id %s with 400",
    async (token) => {
      const result = await call(
        "POST",
        `/api/sensitive-requests/${token}/submit`,
      );
      expect(result.handled).toBe(true);
      expect(result.status).toBe(400);
      expect(result.body).toEqual({
        error: "Invalid request id: malformed URL encoding",
      });
    },
  );

  it.each(["%", "%2"])(
    "rejects malformed cancel id %s with 400",
    async (token) => {
      const result = await call(
        "POST",
        `/api/sensitive-requests/${token}/cancel`,
      );
      expect(result.handled).toBe(true);
      expect(result.status).toBe(400);
      expect(result.body).toEqual({
        error: "Invalid request id: malformed URL encoding",
      });
    },
  );
});
