import http from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(import("@elizaos/core"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    logger: {
      ...actual.logger,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
});

import type { CompatRuntimeState } from "./compat-route-shared";
import { handleElizaCompatRoute } from "./server";

/**
 * H5 (#12228): the app-core compat dispatcher must be default-deny. The
 * declarative policy table + `enforceCompatRouteAuthPolicy` landed in #12214;
 * this test pins the behavior through the REAL dispatcher entrypoint
 * (`handleElizaCompatRoute` → `handleCompatRoute` → `handleCompatRouteInner`),
 * proving the gate short-circuits an un-gated (undeclared) compat route with a
 * 401 BEFORE any `handle*` module runs — i.e. a future handler that forgets its
 * own `ensureRoute*` call still cannot ship an unauthenticated compat route as
 * long as its prefix is compat-managed.
 */

const STATE: CompatRuntimeState = {
  current: null,
  pendingAgentName: null,
  pendingRestartReasons: [],
};

const ENV_KEYS = [
  "ELIZA_API_BIND",
  "ELIZA_API_TOKEN",
  "ELIZA_RUNTIME_MODE",
] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  // Force a non-loopback peer + no token so the request is unauthenticated.
  delete process.env.ELIZA_API_TOKEN;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

function unauthReq(method: string, pathname: string): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = method;
  req.url = pathname;
  req.headers = { host: "example.test:2138" };
  // A remote (non-loopback) peer is never trusted-local, so with no token the
  // request is fully unauthenticated.
  Object.defineProperty(req.socket, "remoteAddress", {
    value: "203.0.113.9",
    configurable: true,
  });
  return req;
}

function captureRes() {
  let body = "";
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  res.assignSocket(new Socket());
  res.end = ((chunk?: string | Buffer) => {
    if (typeof chunk === "string") body += chunk;
    else if (chunk) body += chunk.toString("utf8");
    return res;
  }) as typeof res.end;
  return {
    res,
    status: () => res.statusCode,
    json: () => (body ? JSON.parse(body) : null),
  };
}

describe("compat dispatcher default-deny (H5)", () => {
  it("401s an un-gated, undeclared compat-managed route before any handler runs", async () => {
    // `/api/dev/*` is a compat-managed prefix but this specific path has NO
    // policy entry — the stand-in for a freshly-added handler that forgot to
    // declare its auth policy. The default-deny gate must reject it.
    const cap = captureRes();
    const handled = await handleElizaCompatRoute(
      unauthReq("GET", "/api/dev/__throwaway_h5_ungated__"),
      cap.res,
      STATE,
    );

    expect(handled).toBe(true);
    expect(cap.status()).toBe(401);
    expect(cap.json()).toEqual({ error: "Unauthorized" });
  });

  it("401s an un-gated undeclared secrets (OWNER-prefix) mutation route", async () => {
    const cap = captureRes();
    const handled = await handleElizaCompatRoute(
      unauthReq("POST", "/api/secrets/__throwaway_h5_ungated__"),
      cap.res,
      STATE,
    );

    expect(handled).toBe(true);
    expect(cap.status()).toBe(401);
    expect(cap.json()).toEqual({ error: "Unauthorized" });
  });

  it("lets a genuinely non-compat route fall through to the upstream agent gate", async () => {
    // `/api/messages` is owned by the agent server, not the compat layer. The
    // dispatcher must NOT claim it (returns false) so the agent's own
    // fail-closed gate handles it.
    const cap = captureRes();
    const handled = await handleElizaCompatRoute(
      unauthReq("GET", "/api/messages"),
      cap.res,
      STATE,
    );

    expect(handled).toBe(false);
  });

  it("serves a public compat route (i18n locale) without auth", async () => {
    const cap = captureRes();
    const handled = await handleElizaCompatRoute(
      unauthReq("GET", "/api/i18n/locale"),
      cap.res,
      STATE,
    );

    expect(handled).toBe(true);
    expect(cap.status()).toBe(200);
  });
});
