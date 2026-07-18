/** Regression coverage for inbox caller authority precedence and principals. */
import type http from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearTokenRoleResolvers,
  registerTokenRoleResolver,
} from "./boundary-role-resolver";
import { resolveInboxRequestAuthorization } from "./inbox-request-authorization";

function remoteRequest(): http.IncomingMessage {
  const req = {
    headers: { host: "example.test:2138" },
    method: "POST",
    socket: new Socket(),
  } as http.IncomingMessage;
  Object.defineProperty(req.socket, "remoteAddress", {
    configurable: true,
    value: "203.0.113.10",
  });
  return req;
}

afterEach(() => {
  clearTokenRoleResolvers();
});

describe("resolveInboxRequestAuthorization", () => {
  it("preserves a host session authority before product token resolvers", () => {
    registerTokenRoleResolver({
      id: "product",
      resolve: () => ({
        claims: {},
        isAdmin: true,
        isRouteInScope: () => true,
        principal: "product-owner",
        providerId: "product",
        worldRole: "OWNER",
      }),
    });

    expect(
      resolveInboxRequestAuthorization(
        remoteRequest(),
        "POST",
        "/api/inbox/messages",
        { ok: true, role: "USER", identityId: "machine-1" },
      ),
    ).toEqual({ ok: true, role: "USER", identityId: "machine-1" });
  });

  it("threads an authorized resolver role and stable principal", () => {
    registerTokenRoleResolver({
      id: "product",
      resolve: () => ({
        claims: {},
        isAdmin: true,
        isRouteInScope: () => false,
        principal: "wallet-owner",
        providerId: "product",
        worldRole: "OWNER",
      }),
    });

    expect(
      resolveInboxRequestAuthorization(
        remoteRequest(),
        "POST",
        "/api/inbox/messages",
        { ok: false, role: "NONE" },
      ),
    ).toEqual({
      ok: true,
      role: "OWNER",
      principal: "wallet-owner",
    });
  });

  it("rejects a recognized non-admin resolver outside its route scope", () => {
    registerTokenRoleResolver({
      id: "product",
      resolve: () => ({
        claims: {},
        isAdmin: false,
        isRouteInScope: () => false,
        principal: "scoped-user",
        providerId: "product",
        worldRole: "USER",
      }),
    });

    expect(
      resolveInboxRequestAuthorization(
        remoteRequest(),
        "POST",
        "/api/inbox/messages",
        { ok: false, role: "NONE" },
      ),
    ).toEqual({ ok: false, role: "NONE" });
  });
});
