import { afterEach, beforeEach, expect, it, vi } from "vitest";

const memory = vi.hoisted(() => ({ revoked: false, expired: false, reads: 0 }));
vi.mock("../services/auth-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/auth-store.js")>()),
  authStoreForHost: () => ({
    async findSession(id: string, now: number) {
      memory.reads++;
      return id === "paired-owner" && !memory.revoked && !memory.expired
        ? {
            id,
            identityId: "owner",
            kind: "machine",
            createdAt: now - 1000,
            lastSeenAt: now,
            expiresAt: now + 60000,
            revokedAt: null,
          }
        : null;
    },
    async touchSession() {},
    async findIdentity() {
      return { id: "owner", kind: "owner" };
    },
  }),
}));

import { enforceCompatRouteAuthPolicy } from "./route-auth-policy.ts";

type RouteArgs = Parameters<typeof enforceCompatRouteAuthPolicy>;
beforeEach(() => {
  memory.revoked = false;
  memory.expired = false;
  memory.reads = 0;
  vi.stubEnv("ELIZA_API_TOKEN", "");
  vi.stubEnv("ELIZA_REQUIRE_LOCAL_AUTH", "1");
});
afterEach(() => vi.unstubAllEnvs());
function response() {
  return {
    statusCode: 200,
    setHeader() {},
    end() {},
    headersSent: false,
  } as unknown as RouteArgs[1];
}
async function call(token?: string) {
  const req = {
      method: "POST",
      headers: {
        host: "agent.example.com",
        ...(token ? { authorization: "Bearer " + token } : {}),
      },
      socket: { remoteAddress: "203.0.113.15" },
    } as unknown as RouteArgs[0],
    res = response();
  const verdict = await enforceCompatRouteAuthPolicy(
    req,
    res,
    {} as RouteArgs[2],
    "POST",
    "/api/cloud/warm",
  );
  return { verdict, status: res.statusCode };
}
it("accepts the current paired owner through real session auth", async () => {
  expect(await call("paired-owner")).toEqual({
    verdict: "allowed",
    status: 200,
  });
  expect(memory.reads).toBeGreaterThan(0);
});
it("denies missing credentials", async () => {
  expect(await call()).toEqual({ verdict: "denied", status: 401 });
});
it("denies an unknown paired token", async () => {
  expect(await call("invalid")).toEqual({ verdict: "denied", status: 401 });
});
it.each(["revoked", "expired"] as const)(
  "denies a %s paired token",
  async (kind) => {
    memory[kind] = true;
    expect(await call("paired-owner")).toEqual({
      verdict: "denied",
      status: 401,
    });
  },
);
