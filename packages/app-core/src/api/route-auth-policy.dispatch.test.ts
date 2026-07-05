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
import fs from "node:fs";
import http from "node:http";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CompatRuntimeState } from "./compat-route-shared";
import { handleElizaCompatRoute } from "./server";

const STATE: CompatRuntimeState = {
  current: null,
  pendingAgentName: null,
  pendingRestartReasons: [],
};

const ENV_KEYS = [
  "ELIZA_API_BIND",
  "ELIZA_API_TOKEN",
  "ELIZA_CONFIG_PATH",
  "ELIZA_REQUIRE_LOCAL_AUTH",
  "ELIZA_RUNTIME_MODE",
  "ELIZA_STATE_DIR",
] as const;
let saved: Record<string, string | undefined>;
let stateDir: string | null = null;
let target: http.Server | null = null;
let targetBase = "";
const targetSockets = new Set<Socket>();
const targetHits: Array<{
  authorization: string | undefined;
  method: string;
  url: string;
}> = [];

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  // Force a non-loopback peer + no token so the request is unauthenticated.
  delete process.env.ELIZA_API_TOKEN;
  delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
  delete process.env.ELIZA_CONFIG_PATH;
  targetHits.length = 0;

  target = http.createServer((req, res) => {
    targetHits.push({
      authorization: req.headers.authorization,
      method: req.method ?? "",
      url: req.url ?? "",
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ forwarded: true }));
  });
  target.on("connection", (socket) => {
    targetSockets.add(socket);
    socket.on("close", () => targetSockets.delete(socket));
  });
  await new Promise<void>((resolve) => target?.listen(0, "127.0.0.1", resolve));
  const address = target.address();
  if (!address || typeof address === "string") {
    throw new Error("test target did not bind to a TCP port");
  }
  targetBase = `http://127.0.0.1:${address.port}`;

  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-app-core-mode-"));
  fs.writeFileSync(
    path.join(stateDir, "eliza.json"),
    JSON.stringify(
      {
        deploymentTarget: {
          runtime: "remote",
          remoteApiBase: targetBase,
          remoteAccessToken: "target-token",
        },
        logging: { level: "error" },
      },
      null,
      2,
    ),
  );
  process.env.ELIZA_STATE_DIR = stateDir;
});

afterEach(async () => {
  if (target) {
    for (const socket of targetSockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => target?.close(() => resolve()));
    target = null;
  }
  targetSockets.clear();
  if (stateDir) {
    fs.rmSync(stateDir, { recursive: true, force: true });
    stateDir = null;
  }
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
  if (method === "POST") {
    req.push("{}");
    req.push(null);
  }
  // A remote (non-loopback) peer is never trusted-local, so with no token the
  // request is fully unauthenticated.
  Object.defineProperty(req.socket, "remoteAddress", {
    value: "203.0.113.9",
    configurable: true,
  });
  return req;
}

function bearerReq(
  method: string,
  pathname: string,
  token: string,
): http.IncomingMessage {
  const req = unauthReq(method, pathname);
  req.headers.authorization = `Bearer ${token}`;
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

  it("denies remote-mode cloud mutations before the forwarder sees unauthenticated callers", async () => {
    const cap = captureRes();
    const handled = await handleElizaCompatRoute(
      unauthReq("POST", "/api/cloud/login"),
      cap.res,
      STATE,
    );

    expect(handled).toBe(true);
    expect(cap.status()).toBe(401);
    expect(cap.json()).toEqual({ error: "Unauthorized" });
    expect(targetHits).toHaveLength(0);
  });

  it("forwards remote-mode cloud mutations after compat auth accepts the caller", async () => {
    process.env.ELIZA_API_TOKEN = "local-api-token";
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
    const cap = captureRes();
    const handled = await handleElizaCompatRoute(
      bearerReq("POST", "/api/cloud/login", "local-api-token"),
      cap.res,
      STATE,
    );

    expect(handled).toBe(true);
    expect(cap.status()).toBe(200);
    expect(cap.json()).toEqual({ forwarded: true });
    expect(targetHits).toEqual([
      {
        authorization: "Bearer target-token",
        method: "POST",
        url: "/api/cloud/login",
      },
    ]);
  });
});
