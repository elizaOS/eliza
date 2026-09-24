/**
 * Pins the tokenless authorization branch of the compat sensitive-route helper
 * (`ensureCompatSensitiveRouteAuthorized`): a trusted same-machine loopback
 * caller is granted OWNER, while remote or local-auth-required callers fail
 * closed with 403. Drives the real helper against hand-built Node
 * `http.IncomingMessage`/`ServerResponse` objects — no live server.
 */
import http from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureCompatSensitiveRouteAuthorized } from "../auth.js";

/**
 * #12087 Item 29: the sync boundary helpers `resolveBoundaryRole`/`ensureMinRole`
 * are module-internal now — routes must use the async, DB-aware
 * `ensureRouteMinRole`. Their only public consumer is the tokenless branch of
 * `ensureCompatSensitiveRouteAuthorized`, which names the caller as OWNER only
 * when it is a trusted same-machine request and fails closed (403) otherwise
 * (#9948). This pins that seam through the public API.
 */

function makeReq(
  headers: http.IncomingHttpHeaders,
  remoteAddress = "127.0.0.1",
): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.headers = { ...headers };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: remoteAddress,
    configurable: true,
  });
  return req;
}

function fakeRes(): { res: http.ServerResponse; status(): number } {
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  res.statusCode = 200;
  res.setHeader = () => res;
  res.end = (() => res) as typeof res.end;
  return { res, status: () => res.statusCode };
}

const loopbackOwnerReq = () => makeReq({ host: "localhost:2138" });

// A remote caller cannot be a trusted-local request: it targets a loopback
// Host but originates off-box, so `isTrustedLocalRequest` rejects it.
const remoteReq = (headers: http.IncomingHttpHeaders = {}) =>
  makeReq(
    { host: "localhost:2138", "x-forwarded-for": "203.0.113.9", ...headers },
    "203.0.113.9",
  );

const ENV_KEYS = [
  "ELIZA_REQUIRE_LOCAL_AUTH",
  "ELIZA_DEV_AUTH_BYPASS",
  "ELIZA_CLOUD_PROVISIONED",
  "STEWARD_AGENT_TOKEN",
  "ELIZA_API_TOKEN",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZAOS_CLOUD_API_KEY",
  "NODE_ENV",
] as const;
const BOOT_CONFIG_STORE_KEY = Symbol.for("elizaos.app.boot-config");

function clearEnv() {
  Reflect.deleteProperty(globalThis, BOOT_CONFIG_STORE_KEY);
  for (const key of ENV_KEYS) delete process.env[key];
}

describe("ensureCompatSensitiveRouteAuthorized — tokenless boundary (#9948 / #12087 Item 29)", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("authorizes a trusted loopback OWNER when no API token is configured", () => {
    const res = fakeRes();
    expect(
      ensureCompatSensitiveRouteAuthorized(loopbackOwnerReq(), res.res),
    ).toBe(true);
    // No error status was written.
    expect(res.status()).toBe(200);
  });

  it("rejects a remote, tokenless caller with 403 (fail closed)", () => {
    const res = fakeRes();
    expect(ensureCompatSensitiveRouteAuthorized(remoteReq(), res.res)).toBe(
      false,
    );
    expect(res.status()).toBe(403);
  });

  it("rejects a remote caller with ELIZA_REQUIRE_LOCAL_AUTH set but no configured token", () => {
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
    const res = fakeRes();
    expect(
      ensureCompatSensitiveRouteAuthorized(
        remoteReq({ authorization: "Bearer whatever" }),
        res.res,
      ),
    ).toBe(false);
    expect(res.status()).toBe(403);
  });
});
