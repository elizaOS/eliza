/**
 * Unit coverage for the boundary-role resolver registry — registration
 * order, idempotent replace, fail-closed resolution, and admin/route-scope
 * authorization.
 */

import type http from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BoundaryRoleAccess,
  clearTokenRoleResolvers,
  hasTokenRoleResolver,
  isRegisteredTokenRoleAuthorized,
  registerTokenRoleResolver,
  resolveRegisteredTokenRoleAccess,
  type TokenRoleResolver,
} from "./boundary-role-resolver.ts";

function makeResolver(
  id: string,
  result: BoundaryRoleAccess | null,
  throws = false,
): TokenRoleResolver {
  return {
    id,
    resolve: throws
      ? () => {
          throw new Error("boom");
        }
      : () => result,
  };
}

function makeAccess(
  id: string,
  overrides: Partial<BoundaryRoleAccess> = {},
): BoundaryRoleAccess {
  return {
    providerId: id,
    worldRole: "USER",
    principal: "0xabc",
    isAdmin: false,
    isRouteInScope: () => true,
    claims: {},
    ...overrides,
  };
}

const req = {} as http.IncomingMessage;

describe("boundary-role resolver registry", () => {
  beforeEach(() => {
    clearTokenRoleResolvers();
  });

  it("returns null when no resolvers are registered", () => {
    expect(resolveRegisteredTokenRoleAccess(req)).toBeNull();
    expect(hasTokenRoleResolver("any")).toBe(false);
  });

  it("returns the first non-null resolver in registration order", () => {
    const first = makeResolver("first", null);
    const second = makeResolver(
      "second",
      makeAccess("second", { principal: "p2" }),
    );
    const third = makeResolver(
      "third",
      makeAccess("third", { principal: "p3" }),
    );
    registerTokenRoleResolver(first);
    registerTokenRoleResolver(second);
    registerTokenRoleResolver(third);
    const access = resolveRegisteredTokenRoleAccess(req);
    expect(access?.providerId).toBe("second");
    expect(access?.principal).toBe("p2");
  });

  it("skips resolvers that return null and continues", () => {
    registerTokenRoleResolver(makeResolver("a", null));
    registerTokenRoleResolver(
      makeResolver("b", makeAccess("b", { principal: "found" })),
    );
    expect(resolveRegisteredTokenRoleAccess(req)?.principal).toBe("found");
  });

  it("treats a throwing resolver as a non-match (fail-closed) and continues", () => {
    registerTokenRoleResolver(makeResolver("thrower", null, true));
    registerTokenRoleResolver(
      makeResolver("ok", makeAccess("ok", { principal: "ok" })),
    );
    const access = resolveRegisteredTokenRoleAccess(req);
    expect(access?.providerId).toBe("ok");
  });

  it("stops at the first match even if later resolvers would match", () => {
    registerTokenRoleResolver(
      makeResolver("a", makeAccess("a", { principal: "a" })),
    );
    registerTokenRoleResolver(
      makeResolver("b", makeAccess("b2", { principal: "b" })),
    );
    expect(resolveRegisteredTokenRoleAccess(req)?.principal).toBe("a");
  });

  it("re-registering the same id replaces the prior resolver", () => {
    const first = makeResolver("dup", makeAccess("old", { principal: "old" }));
    const second = makeResolver("dup", makeAccess("new", { principal: "new" }));
    registerTokenRoleResolver(first);
    registerTokenRoleResolver(second);
    expect(resolveRegisteredTokenRoleAccess(req)?.principal).toBe("new");
    expect(hasTokenRoleResolver("dup")).toBe(true);
  });

  it("unregister removes only the same instance", () => {
    const first = makeResolver("x", makeAccess("old", { principal: "old" }));
    const second = makeResolver("x", makeAccess("new", { principal: "new" }));
    const unregisterFirst = registerTokenRoleResolver(first);
    registerTokenRoleResolver(second);
    unregisterFirst(); // must NOT remove second (different instance)
    expect(resolveRegisteredTokenRoleAccess(req)?.principal).toBe("new");
    const unregisterSecond = registerTokenRoleResolver(second);
    unregisterSecond();
    expect(resolveRegisteredTokenRoleAccess(req)).toBeNull();
  });
});

describe("isRegisteredTokenRoleAuthorized", () => {
  beforeEach(() => {
    clearTokenRoleResolvers();
  });

  it("returns false when nothing recognises the request", () => {
    expect(isRegisteredTokenRoleAuthorized(req, "GET", "/api/x")).toBe(false);
  });

  it("authorizes admins unconditionally", () => {
    registerTokenRoleResolver(
      makeResolver(
        "admin",
        makeAccess("admin", { isAdmin: true, isRouteInScope: () => false }),
      ),
    );
    expect(
      isRegisteredTokenRoleAuthorized(req, "DELETE", "/api/anything"),
    ).toBe(true);
  });

  it("authorizes non-admins only for in-scope routes", () => {
    const access = makeAccess("user", {
      isAdmin: false,
      isRouteInScope: (method, pathname) =>
        method === "GET" && pathname === "/api/me",
    });
    registerTokenRoleResolver(makeResolver("user", access));
    expect(isRegisteredTokenRoleAuthorized(req, "GET", "/api/me")).toBe(true);
    expect(isRegisteredTokenRoleAuthorized(req, "GET", "/api/other")).toBe(
      false,
    );
    expect(isRegisteredTokenRoleAuthorized(req, "POST", "/api/me")).toBe(false);
  });

  it("normalizes method to uppercase before the scope check", () => {
    const access = makeAccess("user", {
      isAdmin: false,
      isRouteInScope: (method) => method === "GET",
    });
    const spy = vi.fn(access.isRouteInScope);
    registerTokenRoleResolver(
      makeResolver("user", { ...access, isRouteInScope: spy }),
    );
    expect(isRegisteredTokenRoleAuthorized(req, "get", "/api/me")).toBe(true);
    expect(spy).toHaveBeenCalledWith("GET", "/api/me");
  });
});
