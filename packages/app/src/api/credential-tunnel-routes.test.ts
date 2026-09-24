/**
 * Exercises `handleCredentialTunnelRoute` — the POST `/api/credential-tunnel`
 * (+ legacy `/submit` alias) handler that hands a credential from the owner
 * runtime to a sub-agent session via the SubAgentCredentialBridge service.
 * Drives both a vi-mocked bridge and the real bridge adapter (over a real
 * credential-tunnel + dispatch registry) with fake http req/res; asserts the
 * OWNER-auth gate, no-bridge 503, identifier validation, single-redemption, and
 * the full CredentialScopeError-code → HTTP-status mapping.
 */
import * as http from "node:http";
import { Socket } from "node:net";
import { createSensitiveRequestDispatchRegistry } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CredentialScopeError,
  createCredentialTunnelService,
  createSubAgentCredentialBridgeAdapter,
  SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE,
  type SubAgentCredentialBridge,
} from "../services/credential-tunnel-service";
import { _resetAuthRateLimiter } from "./auth";
import type { CompatRuntimeState } from "./compat-route-shared";
import { handleCredentialTunnelRoute } from "./credential-tunnel-routes";

const BOOT_CONFIG_STORE_KEY = Symbol.for("elizaos.app.boot-config");
const AUTH_ENV_KEYS = [
  "ELIZA_API_TOKEN",
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZA_DEV_AUTH_BYPASS",
  "ELIZA_REQUIRE_LOCAL_AUTH",
  "NODE_ENV",
] as const;
const OWNER_TOKEN = "credential-tunnel-owner-token";

const savedAuthEnv: Record<(typeof AUTH_ENV_KEYS)[number], string | undefined> =
  {
    ELIZA_API_TOKEN: undefined,
    ELIZA_CLOUD_PROVISIONED: undefined,
    ELIZA_DEV_AUTH_BYPASS: undefined,
    ELIZA_REQUIRE_LOCAL_AUTH: undefined,
    NODE_ENV: undefined,
  };

function clearRouteAuthState(): void {
  Reflect.deleteProperty(globalThis, BOOT_CONFIG_STORE_KEY);
  for (const key of AUTH_ENV_KEYS) {
    delete process.env[key];
  }
}

interface FakeRes {
  res: http.ServerResponse;
  body(): unknown;
  status(): number;
}

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
  body?: unknown;
  ip?: string;
  host?: string;
  headers?: http.IncomingHttpHeaders;
  auth?: "owner" | "none";
}): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = opts.method;
  req.url = opts.pathname;
  req.headers = {
    host: opts.host ?? "localhost:2138",
    ...(opts.auth === "none" ? {} : { authorization: `Bearer ${OWNER_TOKEN}` }),
    ...(opts.headers ?? {}),
  };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: opts.ip ?? "127.0.0.1",
    configurable: true,
  });
  if (opts.body !== undefined) {
    (req as { body?: unknown }).body = opts.body;
  }
  return req;
}

function stateWithBridge(
  bridge: Partial<SubAgentCredentialBridge> | null,
): CompatRuntimeState {
  return {
    current: {
      getService: vi.fn((name: string) =>
        name === SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE ? bridge : null,
      ),
    } as never,
    pendingAgentName: null,
    pendingRestartReasons: [],
  };
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    childSessionId: "pty-1-abc",
    credentialScopeId: "cred_scope_test",
    key: "OPENAI_API_KEY",
    value: "sk-test-12345",
    ...overrides,
  };
}

async function callRoute(
  req: http.IncomingMessage,
  state: CompatRuntimeState,
): Promise<FakeRes> {
  const res = fakeRes();
  const handled = await handleCredentialTunnelRoute(req, res.res, state);
  expect(handled).toBe(true);
  return res;
}

describe("credential tunnel route", () => {
  beforeEach(() => {
    for (const key of AUTH_ENV_KEYS) {
      savedAuthEnv[key] = process.env[key];
    }
    clearRouteAuthState();
    _resetAuthRateLimiter();
    process.env.ELIZA_API_TOKEN = OWNER_TOKEN;
  });

  afterEach(() => {
    _resetAuthRateLimiter();
    Reflect.deleteProperty(globalThis, BOOT_CONFIG_STORE_KEY);
    for (const key of AUTH_ENV_KEYS) {
      if (savedAuthEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedAuthEnv[key];
    }
  });

  it("tunnels a credential through the registered owner-runtime bridge", async () => {
    const tunnelCredential = vi.fn(async () => {});
    const bridge = { tunnelCredential };

    const res = await callRoute(
      fakeReq({
        method: "POST",
        pathname: "/api/credential-tunnel",
        body: validBody(),
      }),
      stateWithBridge(bridge),
    );

    expect(res.status()).toBe(200);
    expect(res.body()).toEqual({
      ok: true,
      childSessionId: "pty-1-abc",
      credentialScopeId: "cred_scope_test",
      key: "OPENAI_API_KEY",
    });
    expect(tunnelCredential).toHaveBeenCalledWith(validBody());
  });

  it("accepts the legacy /submit route alias", async () => {
    const tunnelCredential = vi.fn(async () => {});

    const res = await callRoute(
      fakeReq({
        method: "POST",
        pathname: "/api/credential-tunnel/submit",
        body: validBody(),
      }),
      stateWithBridge({ tunnelCredential }),
    );

    expect(res.status()).toBe(200);
    expect(tunnelCredential).toHaveBeenCalledWith(validBody());
  });

  it("tunnels through the real bridge adapter and redeems exactly once", async () => {
    const adapter = createSubAgentCredentialBridgeAdapter({
      tunnel: createCredentialTunnelService(),
      dispatch: createSensitiveRequestDispatchRegistry(),
      runtime: { agentId: "parent-agent" } as never,
    });
    const scope = await adapter.declareScope({
      childSessionId: "pty-1-abc",
      credentialKeys: ["OPENAI_API_KEY", "STRIPE_KEY"],
    });

    const res = await callRoute(
      fakeReq({
        method: "POST",
        pathname: "/api/credential-tunnel",
        body: validBody({
          credentialScopeId: scope.credentialScopeId,
          value: "sk-real-owner-route",
        }),
      }),
      stateWithBridge(adapter),
    );

    expect(res.status()).toBe(200);
    expect(res.body()).toEqual({
      ok: true,
      childSessionId: "pty-1-abc",
      credentialScopeId: scope.credentialScopeId,
      key: "OPENAI_API_KEY",
    });
    expect(
      await adapter.tryRetrieveCredential({
        childSessionId: "pty-1-abc",
        key: "OPENAI_API_KEY",
        scopedToken: scope.scopedToken,
      }),
    ).toEqual({ status: "ready", value: "sk-real-owner-route" });
    expect(
      await adapter.tryRetrieveCredential({
        childSessionId: "pty-1-abc",
        key: "OPENAI_API_KEY",
        scopedToken: scope.scopedToken,
      }),
    ).toEqual({ status: "rejected", reason: "already_redeemed" });
  });

  it("rejects remote callers without owner authentication", async () => {
    const tunnelCredential = vi.fn(async () => {});

    const res = await callRoute(
      fakeReq({
        method: "POST",
        pathname: "/api/credential-tunnel",
        ip: "203.0.113.8",
        host: "agent.example.test",
        auth: "none",
        body: validBody(),
      }),
      stateWithBridge({ tunnelCredential }),
    );

    expect(res.status()).toBe(401);
    expect(res.body()).toEqual({ error: "Unauthorized" });
    expect(tunnelCredential).not.toHaveBeenCalled();
  });

  it("returns 503 when the parent credential bridge is not registered", async () => {
    const res = await callRoute(
      fakeReq({
        method: "POST",
        pathname: "/api/credential-tunnel",
        body: validBody(),
      }),
      stateWithBridge(null),
    );

    expect(res.status()).toBe(503);
    expect(res.body()).toEqual({
      ok: false,
      error: "credential bridge unavailable",
      code: "no_adapter",
    });
  });

  it.each([
    ["invalid_input", 400],
    ["key_not_in_scope", 400],
    ["invalid_token", 400],
    ["unknown_scope", 404],
    ["scope_expired", 410],
    ["session_mismatch", 403],
    ["already_redeemed", 403],
    ["no_ciphertext", 409],
  ] as const)("maps %s to HTTP %s with the same code", async (code, status) => {
    const tunnelCredential = vi.fn(async () => {
      throw new CredentialScopeError(code, code);
    });

    const res = await callRoute(
      fakeReq({
        method: "POST",
        pathname: "/api/credential-tunnel",
        body: validBody(),
      }),
      stateWithBridge({ tunnelCredential }),
    );

    expect(res.status()).toBe(status);
    expect(res.body()).toEqual({ ok: false, error: code, code });
  });

  it("rejects malformed identifiers before invoking the bridge", async () => {
    const tunnelCredential = vi.fn(async () => {});

    const res = await callRoute(
      fakeReq({
        method: "POST",
        pathname: "/api/credential-tunnel",
        body: validBody({ key: "../OPENAI_API_KEY" }),
      }),
      stateWithBridge({ tunnelCredential }),
    );

    expect(res.status()).toBe(400);
    expect(tunnelCredential).not.toHaveBeenCalled();
  });
});
