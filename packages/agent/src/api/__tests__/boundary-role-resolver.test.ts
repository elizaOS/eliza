/** Verifies token role resolver registration, scope checks, and fail-closed authorization. */

import type http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoundaryRoleAccess, TokenRoleResolver } from "../boundary-role-resolver.ts";
import {
  clearTokenRoleResolvers,
  hasTokenRoleResolver,
  isRegisteredTokenRoleAuthorized,
  registerTokenRoleResolver,
  resolveRegisteredTokenRoleAccess,
} from "../boundary-role-resolver.ts";

function fakeResolver(
  id: string,
  access: BoundaryRoleAccess | null,
  opts: { throws?: boolean } = {},
): TokenRoleResolver {
  return {
    id,
    resolve: () => {
      if (opts.throws) throw new Error("boom");
      return access;
    },
  };
}

function fakeReq(): http.IncomingMessage {
  return {} as http.IncomingMessage;
}

const access = (
  overrides: Partial<BoundaryRoleAccess> = {},
): BoundaryRoleAccess => ({
  providerId: "test",
  worldRole: "USER",
  principal: "p1",
  isAdmin: false,
  isRouteInScope: () => true,
  claims: {},
  ...overrides,
});

afterEach(() => clearTokenRoleResolvers());

describe("boundary-role resolver registry", () => {
  it("registers and detects a resolver", () => {
    registerTokenRoleResolver(fakeResolver("r1", access()));
    expect(hasTokenRoleResolver("r1")).toBe(true);
    expect(hasTokenRoleResolver("missing")).toBe(false);
  });

  it("returns the first non-null access in registration order", () => {
    registerTokenRoleResolver(fakeResolver("r1", null));
    const expected = access({ principal: "winner" });
    registerTokenRoleResolver(fakeResolver("r2", expected));
    registerTokenRoleResolver(fakeResolver("r3", access({ principal: "loser" })));
    const result = resolveRegisteredTokenRoleAccess(fakeReq());
    expect(result?.principal).toBe("winner");
  });

  it("returns null when no resolver recognises the request", () => {
    registerTokenRoleResolver(fakeResolver("r1", null));
    expect(resolveRegisteredTokenRoleAccess(fakeReq())).toBeNull();
  });

  it("treats a throwing resolver as a non-match", () => {
    registerTokenRoleResolver(fakeResolver("r1", access(), { throws: true }));
    const fallback = access({ principal: "fallback" });
    registerTokenRoleResolver(fakeResolver("r2", fallback));
    expect(resolveRegisteredTokenRoleAccess(fakeReq())?.principal).toBe("fallback");
  });

  it("re-registering the same id replaces the prior resolver", () => {
    registerTokenRoleResolver(fakeResolver("r1", access({ principal: "old" })));
    registerTokenRoleResolver(fakeResolver("r1", access({ principal: "new" })));
    expect(resolveRegisteredTokenRoleAccess(fakeReq())?.principal).toBe("new");
  });

  it("unregister only removes the same instance", () => {
    const unregister = registerTokenRoleResolver(
      fakeResolver("r1", access({ principal: "first" })),
    );
    // A later re-registration owns the slot; unregistering the old instance
    // must not remove the new one.
    registerTokenRoleResolver(fakeResolver("r1", access({ principal: "second" })));
    unregister();
    expect(hasTokenRoleResolver("r1")).toBe(true);
  });

  it("unregister removes the only instance", () => {
    const unregister = registerTokenRoleResolver(
      fakeResolver("r1", access()),
    );
    unregister();
    expect(hasTokenRoleResolver("r1")).toBe(false);
  });
});

describe("isRegisteredTokenRoleAuthorized", () => {
  it("authorizes admins unconditionally", () => {
    registerTokenRoleResolver(
      fakeResolver("r1", access({ isAdmin: true })),
    );
    expect(isRegisteredTokenRoleAuthorized(fakeReq(), "GET", "/any/route")).toBe(true);
  });

  it("checks route scope for non-admins", () => {
    const inScope = vi.fn((m: string, p: string) => m === "GET" && p === "/ok");
    registerTokenRoleResolver(
      fakeResolver("r1", access({ isAdmin: false, isRouteInScope: inScope })),
    );
    expect(isRegisteredTokenRoleAuthorized(fakeReq(), "get", "/ok")).toBe(true);
    expect(inScope).toHaveBeenCalledWith("GET", "/ok");
    expect(isRegisteredTokenRoleAuthorized(fakeReq(), "POST", "/ok")).toBe(false);
  });

  it("denies unrecognised requests", () => {
    expect(isRegisteredTokenRoleAuthorized(fakeReq(), "GET", "/x")).toBe(false);
  });
});
