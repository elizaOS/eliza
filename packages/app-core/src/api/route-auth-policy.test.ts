import http from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";
import {
  COMPAT_ROUTE_AUTH_POLICIES,
  enforceCompatRouteAuthPolicy,
  isCompatManagedRoute,
  resolveCompatRouteAuthPolicy,
} from "./route-auth-policy";

const STATE: CompatRuntimeState = {
  current: null,
  pendingAgentName: null,
  pendingRestartReasons: [],
};

function fakeReq(options: {
  method: string;
  pathname: string;
  headers?: http.IncomingHttpHeaders;
  remoteAddress?: string;
}): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = options.method;
  req.url = options.pathname;
  req.headers = {
    host: "example.test:2138",
    ...(options.headers ?? {}),
  };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: options.remoteAddress ?? "203.0.113.9",
    configurable: true,
  });
  return req;
}

function fakeRes() {
  let body = "";
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  res.statusCode = 200;
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

describe("compat route auth policy table", () => {
  it("has stable unique policy ids", () => {
    const ids = COMPAT_ROUTE_AUTH_POLICIES.map((policy) => policy.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares auth tiers for representative compat routes", () => {
    expect(
      resolveCompatRouteAuthPolicy("GET", "/api/auth/status"),
    ).toMatchObject({ id: "auth.status", tier: "public" });
    expect(
      resolveCompatRouteAuthPolicy("GET", "/api/first-run/status"),
    ).toMatchObject({ id: "first-run.status", tier: "session" });
    expect(
      resolveCompatRouteAuthPolicy("GET", "/api/secrets/inventory"),
    ).toMatchObject({ id: "secrets", tier: "OWNER" });
    expect(
      resolveCompatRouteAuthPolicy("GET", "/api/database/tables/foo/rows"),
    ).toMatchObject({ id: "database.rows", tier: "OWNER" });
    expect(
      resolveCompatRouteAuthPolicy("POST", "/api/tts/cloud"),
    ).toMatchObject({ id: "tts.cloud", tier: "session" });
    expect(
      resolveCompatRouteAuthPolicy("POST", "/api/background/upload-image"),
    ).toMatchObject({ id: "background.upload-image", tier: "session" });
    expect(
      resolveCompatRouteAuthPolicy("POST", "/api/tts/elevenlabs"),
    ).toMatchObject({
      id: "tts.elevenlabs-passthrough",
      tier: "public",
    });
  });

  it("fails closed for undeclared app-core-managed routes", async () => {
    const req = fakeReq({ method: "GET", pathname: "/api/dev/not-declared" });
    const res = fakeRes();

    await expect(
      enforceCompatRouteAuthPolicy(
        req,
        res.res,
        STATE,
        "GET",
        "/api/dev/not-declared",
      ),
    ).resolves.toBe("denied");
    expect(res.status()).toBe(401);
    expect(res.json()).toEqual({ error: "Unauthorized" });
  });

  it("does not let prefix policies bleed into sibling path names", () => {
    expect(resolveCompatRouteAuthPolicy("GET", "/api/pluginsx")).toBeNull();
    expect(isCompatManagedRoute("/api/pluginsx")).toBe(false);
    expect(resolveCompatRouteAuthPolicy("GET", "/pairing")).toBeNull();
    expect(isCompatManagedRoute("/pairing")).toBe(false);
  });

  it("lets non-compat routes fall through to the upstream server", async () => {
    const req = fakeReq({ method: "GET", pathname: "/api/messages" });
    const res = fakeRes();

    expect(isCompatManagedRoute("/api/messages")).toBe(false);
    expect(isCompatManagedRoute("/api/device-e2e/upload-image")).toBe(false);
    await expect(
      enforceCompatRouteAuthPolicy(req, res.res, STATE, "GET", "/api/messages"),
    ).resolves.toBe("unmanaged");
    expect(res.status()).toBe(200);
    expect(res.json()).toBeNull();
  });

  it("allows public declarations without a session", async () => {
    const req = fakeReq({ method: "GET", pathname: "/api/i18n/locale" });
    const res = fakeRes();

    await expect(
      enforceCompatRouteAuthPolicy(
        req,
        res.res,
        STATE,
        "GET",
        "/api/i18n/locale",
      ),
    ).resolves.toBe("allowed");
    expect(res.status()).toBe(200);
  });
});
