/**
 * Production-path regression coverage for the account-pool broker mount.
 *
 * The pre-existing broker tests (`account-pool-broker-routes.test.ts`) call
 * `handleAccountPoolBrokerRoute` DIRECTLY with whatever path the test fixture
 * chooses, so they cannot detect a prefix that the real dispatcher never
 * routes to the handler. That is exactly the gap that shipped: with
 * `ROUTE_PREFIX = "/internal/account-pool/v1"` (missing `/api`) the handler
 * was dead code in production — the compat dispatcher only reaches
 * `handleInternalWakeRoute` (which delegates to the broker) for
 * `/api/internal/*` paths and never strips `/api`, so every lease request
 * fell through to generic auth (401) and fail-closed pool proxies surfaced
 * that as 503 "broker unavailable".
 *
 * These tests drive the REAL dispatcher entrypoint (`handleElizaCompatRoute`
 * → compat route chain → `handleInternalWakeRoute` → broker handler) with the
 * canonical `/api/internal/account-pool/v1/*` paths the pool proxy actually
 * calls, so a future prefix regression fails here instead of in production.
 */
import { mkdtempSync, rmSync } from "node:fs";
import * as http from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveAccount } from "@elizaos/auth/account-storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetDefaultAccountPoolForTests } from "../services/account-pool.js";
import { __resetAccountPoolBrokerRoutesForTests } from "./account-pool-broker-routes.js";
import type { CompatRuntimeState } from "./compat-route-shared";
import { handleElizaCompatRoute } from "./server";

const SECRET = "dispatch-broker-fixture-secret-at-least-32-chars";
const REFRESH_SECRET = "sk-ant-oat-dispatch-primary-refresh";
const FAR_FUTURE = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;

const STATE: CompatRuntimeState = {
  current: null,
  pendingAgentName: null,
  pendingRestartReasons: [],
};

let home: string;
let saved: Record<string, string | undefined>;
const ENV_KEYS = [
  "ELIZA_HOME",
  "ELIZA_STATE_DIR",
  "ELIZA_ACCOUNT_POOL_BROKER_ENABLED",
  "ELIZA_ACCOUNT_POOL_BROKER_SECRET",
  "ELIZA_ACCOUNT_POOL_BROKER_LEASE_TTL_MS",
] as const;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  home = mkdtempSync(path.join(tmpdir(), "account-pool-broker-dispatch-"));
  process.env.ELIZA_HOME = home;
  process.env.ELIZA_STATE_DIR = home;
  process.env.ELIZA_ACCOUNT_POOL_BROKER_ENABLED = "1";
  process.env.ELIZA_ACCOUNT_POOL_BROKER_SECRET = SECRET;
  delete process.env.ELIZA_ACCOUNT_POOL_BROKER_LEASE_TTL_MS;
  __resetDefaultAccountPoolForTests();
  __resetAccountPoolBrokerRoutesForTests();
});

afterEach(() => {
  __resetAccountPoolBrokerRoutesForTests();
  __resetDefaultAccountPoolForTests();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true });
});

function loopbackReq(
  method: string,
  pathname: string,
  options: { auth?: string; body?: Record<string, unknown> } = {},
): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = method;
  req.url = pathname;
  req.headers = { host: "127.0.0.1:18792" };
  if (options.auth !== undefined) req.headers.authorization = options.auth;
  if (options.body !== undefined) {
    (req as { body?: unknown }).body = options.body;
  }
  Object.defineProperty(req.socket, "remoteAddress", {
    value: "127.0.0.1",
    configurable: true,
  });
  return req;
}

function captureRes() {
  let body = "";
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  const socket = new Socket();
  res.assignSocket(socket);
  res.end = ((chunk?: string | Buffer) => {
    if (typeof chunk === "string") body += chunk;
    else if (chunk) body += chunk.toString("utf8");
    socket.destroy();
    return res;
  }) as typeof res.end;
  return {
    res,
    status: () => res.statusCode,
    json: () => (body ? JSON.parse(body) : null),
  };
}

describe("account-pool broker routes through the real compat dispatcher", () => {
  it("serves /api/internal/account-pool/v1/health via the dispatcher path", async () => {
    const cap = captureRes();
    const handled = await handleElizaCompatRoute(
      loopbackReq("GET", "/api/internal/account-pool/v1/health", {
        auth: `Bearer ${SECRET}`,
      }),
      cap.res,
      STATE,
    );

    expect(handled).toBe(true);
    // On the broken prefix this request never reaches the broker: it falls
    // through to generic auth / terminal compat handlers and the body has no
    // broker health shape. The assertion below pins the production contract
    // the pool proxy depends on.
    expect(cap.status()).toBe(200);
    expect(cap.json()).toMatchObject({ ok: true, enabled: true });
  });

  it("leases an account via POST /api/internal/account-pool/v1/lease through the dispatcher", async () => {
    saveAccount({
      id: "dispatch-primary",
      providerId: "anthropic-subscription",
      label: "dispatch-primary",
      source: "oauth",
      credentials: {
        access: "sk-ant-oat-dispatch-primary",
        refresh: REFRESH_SECRET,
        expires: FAR_FUTURE,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const cap = captureRes();
    const handled = await handleElizaCompatRoute(
      loopbackReq("POST", "/api/internal/account-pool/v1/lease", {
        auth: `Bearer ${SECRET}`,
        body: {
          providerId: "anthropic-subscription",
          sessionKey: "dispatch-test:s1",
        },
      }),
      cap.res,
      STATE,
    );

    expect(handled).toBe(true);
    expect(cap.status()).toBe(200);
    const body = cap.json() as Record<string, unknown>;
    expect(body.accountId).toBe("dispatch-primary");
    expect(body.accessToken).toBe("sk-ant-oat-dispatch-primary");
    // Two independent leak checks: the saved refresh secret must never appear
    // in a lease response (value-level, independent of fixture spelling), and
    // no `refresh*` key should be serialized either (shape-level).
    expect(JSON.stringify(body)).not.toContain(REFRESH_SECRET);
    expect(JSON.stringify(body)).not.toContain("refresh");
  });

  it("still 401s a wrong bearer with the broker's own error shape (not generic auth)", async () => {
    const cap = captureRes();
    const handled = await handleElizaCompatRoute(
      loopbackReq("GET", "/api/internal/account-pool/v1/health", {
        auth: "Bearer wrong-secret-wrong-secret-wrong-secret",
      }),
      cap.res,
      STATE,
    );

    expect(handled).toBe(true);
    expect(cap.status()).toBe(401);
    // Broker shape is {ok:false,error:"unauthorized"}; the generic /api
    // fallback is {"error":"Unauthorized"}. The distinction is exactly how
    // the production outage was diagnosed, so pin it.
    expect(cap.json()).toEqual({ ok: false, error: "unauthorized" });
  });
});
