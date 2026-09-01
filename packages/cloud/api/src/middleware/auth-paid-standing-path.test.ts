/**
 * Mounts the production global auth boundary around the real paid-standing
 * helper to prove guarded route shapes do not hydrate Steward sessions before
 * their one combined identity-and-standing resolution.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const getCurrentUser = mock();
const resolveInferenceAuthContext = mock();
const observeInferenceApiKeyUsage = mock();

mock.module("@/lib/auth/workers-hono-auth", () => ({
  getCurrentUser,
  requireUserOrApiKeyWithOrg: mock(),
}));
mock.module("@/lib/services/inference-auth-context", () => ({
  observeInferenceApiKeyUsage,
  resolveInferenceAuthContext,
}));

const { authMiddleware, isRouteAuthenticatedPaidStandingPath } = await import(
  "./auth"
);
const { requirePaidRouteStanding } = await import("../lib/paid-route-standing");

const app = new Hono<AppEnv>();
app.use("*", authMiddleware);
app.all("*", async (c) => {
  const caller = await requirePaidRouteStanding(c, {
    route: "mounted.paid-standing.probe",
  });
  return c.json({ userId: caller.user.id });
});

const executionContext = {
  props: {},
  waitUntil(_promise: Promise<unknown>) {},
  passThroughOnException() {},
};

const guardedRoutes = [
  ["storage", "POST", "/api/v1/apis/storage/presign"],
  ["domain", "POST", "/api/v1/apps/app-1/domains/buy"],
  ["tunnel", "POST", "/api/v1/apis/tunnels/tailscale/auth-key"],
  ["credential broker", "POST", "/api/v1/connections/connection-1/broker"],
] as const;

describe("production-mounted paid standing auth boundary", () => {
  beforeEach(() => {
    getCurrentUser.mockReset();
    resolveInferenceAuthContext.mockReset();
    observeInferenceApiKeyUsage.mockReset();
    getCurrentUser.mockResolvedValue({ id: "unexpected-global-user" });
    resolveInferenceAuthContext.mockResolvedValue({
      kind: "authorized",
      source: "cache",
      ctx: {
        userId: "user-1",
        orgId: "org-1",
        apiKeyId: null,
        admission: null,
      },
    });
  });

  test.each(guardedRoutes)(
    "Steward cookie reaches one combined read without global hydration for %s",
    async (_name, method, pathname) => {
      const response = await app.fetch(
        new Request(`https://api.eliza.app${pathname}`, {
          method,
          headers: { cookie: "steward-token=signed-session" },
        }),
        {} as never,
        executionContext,
      );

      expect(response.status).toBe(200);
      expect(getCurrentUser).not.toHaveBeenCalled();
      expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(1);
    },
  );

  test.each(guardedRoutes)(
    "API key reaches one combined read without global hydration for %s",
    async (_name, method, pathname) => {
      const response = await app.fetch(
        new Request(`https://api.eliza.app${pathname}`, {
          method,
          headers: { "x-api-key": "eliza_test_key" },
        }),
        {} as never,
        executionContext,
      );

      expect(response.status).toBe(200);
      expect(getCurrentUser).not.toHaveBeenCalled();
      expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    ["GET", "/api/v1/remote/hosts"],
    ["POST", "/api/v1/connections/connection-1/refresh"],
    ["GET", "/api/v1/apps/app-1/domains/check"],
    ["POST", "/api/v1/remote/hosts/host-1/managed-network/activate"],
    ["GET", "/api/v1/connections/connection-1/broker"],
    ["GET", "/api/v1/apis/storage/presign"],
  ])(
    "keeps recovery/read neighbor globally classified for %s %s",
    (method, path) => {
      expect(isRouteAuthenticatedPaidStandingPath(method, path)).toBe(false);
    },
  );
});
