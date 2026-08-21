/**
 * Exercises OAuth connection platform validation through the HTTP route with
 * mocked authentication, logging, and service boundaries.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (_c: unknown, err: unknown) => {
    throw err;
  },
  ApiError: class ApiError extends Error {},
}));
mock.module("@/lib/api/errors", () => ({
  ApiError: class ApiError extends Error {},
}));
const loggerError = mock(
  (_message: string, _context?: Record<string, unknown>) => undefined,
);
mock.module("@/lib/utils/logger", () => ({
  logger: { debug: mock(() => undefined), error: loggerError },
}));

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-1",
  organization_id: "org-1",
}));
const listConnections = mock(
  async (_params: {
    organizationId: string;
    userId?: string;
    platform?: string;
    connectionRole?: string;
  }) => [],
);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/services/oauth", () => ({
  internalErrorResponse: (message: string) => ({ error: message }),
  OAuthError: class OAuthError extends Error {},
  oauthService: { listConnections },
}));

const { default: connectionsRoute } = await import("./route");

function buildApp() {
  const app = new Hono<AppEnv>();
  app.route("/api/v1/oauth/connections", connectionsRoute);
  return app;
}

function request(query = "") {
  return buildApp().request(`/api/v1/oauth/connections${query}`);
}

describe("GET /api/v1/oauth/connections catalog platform identity", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
    listConnections.mockClear();
    loggerError.mockClear();
  });

  test.each(["", "?platform="])(
    "accepts %s as an unfiltered OAuth connection catalog",
    async (query) => {
      const response = await request(query);
      expect(response.status).toBe(200);
      expect(listConnections).toHaveBeenCalledTimes(1);
      expect(listConnections).toHaveBeenCalledWith({
        organizationId: "org-1",
        userId: "user-1",
        platform: undefined,
        connectionRole: undefined,
      });
    },
  );

  test("accepts platform=google as the Google connection catalog", async () => {
    const response = await request("?platform=google");
    expect(response.status).toBe(200);
    expect(listConnections).toHaveBeenCalledTimes(1);
    expect(listConnections).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      platform: "google",
      connectionRole: undefined,
    });
  });

  test.each(["GOOGLE", "gmail", "foo", "1e2"])(
    "rejects platform=%s before listConnections",
    async (token) => {
      const response = await request(`?platform=${token}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("INVALID_PLATFORM");
      expect(listConnections).not.toHaveBeenCalled();
    },
  );

  test("translates a connection lookup failure after logging its platform", async () => {
    listConnections.mockImplementationOnce(async () => {
      throw new Error("lookup failed");
    });

    const response = await request("?platform=google");

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body).toEqual({
      error: "Failed to list OAuth connections",
    });
    expect(loggerError).toHaveBeenCalledWith(
      "[API] GET /api/v1/oauth/connections error",
      expect.objectContaining({
        organizationId: "org-1",
        platform: "google",
        error: "lookup failed",
      }),
    );
  });
});
