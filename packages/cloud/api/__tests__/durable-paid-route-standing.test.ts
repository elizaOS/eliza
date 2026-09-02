/**
 * Drives the tunnel and credential-broker Hono routes with deterministic
 * collaborators, proving standing denial precedes external dispatch and the
 * tunnel route keeps synchronous debit/refund settlement around Headscale.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { ApiError } from "@/lib/api/cloud-worker-errors";

const ORG = "00000000-0000-4000-8000-000000030263";
const USER = "00000000-0000-4000-8000-000000030264";
const CONNECTION = "00000000-0000-4000-8000-000000030265";

const requirePaidRouteStanding = mock();
const deductCredits = mock();
const refundCredits = mock();
const createPreAuthKey = mock();
const callProvider = mock();
const loggerError = mock();

mock.module("@/api-app/lib/paid-route-standing", () => ({
  requirePaidRouteStanding,
}));
mock.module("@/lib/services/credits", () => ({
  creditsService: { deductCredits, refundCredits },
}));
mock.module("@/lib/services/headscale-client", () => ({
  HeadscaleClient: class {
    createPreAuthKey = createPreAuthKey;
  },
}));
mock.module("@/lib/services/oauth", () => ({
  credentialBroker: { callProvider },
  OAuthError: class extends Error {},
  internalErrorResponse: (message: string) => ({ error: message }),
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: loggerError,
    warn: mock(),
    info: mock(),
  },
}));

const tunnelRoute = (
  await import("../v1/apis/tunnels/tailscale/auth-key/route")
).default;
const brokerRoute = (await import("../v1/connections/[id]/broker/route"))
  .default;

const tunnelApp = new Hono();
tunnelApp.route("/api/v1/apis/tunnels/tailscale/auth-key", tunnelRoute);
const brokerApp = new Hono();
brokerApp.route("/api/v1/connections/:id/broker", brokerRoute);

const authorized = {
  user: { id: USER, organization_id: ORG },
  apiKeyId: "key-1",
  authSource: "combined_cache",
  appScopeId: null,
};

beforeEach(() => {
  requirePaidRouteStanding.mockReset();
  deductCredits.mockReset();
  refundCredits.mockReset();
  createPreAuthKey.mockReset();
  callProvider.mockReset();
  loggerError.mockReset();
  requirePaidRouteStanding.mockResolvedValue(authorized);
  deductCredits.mockResolvedValue({ success: true, newBalance: 9.99 });
  refundCredits.mockResolvedValue({ success: true, newBalance: 10 });
  createPreAuthKey.mockResolvedValue({
    key: "opaque-headscale-key",
    expiration: "2026-09-01T18:00:00.000Z",
  });
  callProvider.mockResolvedValue({
    connectionId: CONNECTION,
    platform: "github",
    status: 200,
    headers: {},
    body: "{}",
    bodyEncoding: "utf8",
    tokenRefreshed: false,
  });
});

function standingDenial(): ApiError {
  return new ApiError(403, "access_denied", "Organization is inactive", {
    reason: "organization_inactive",
  });
}

describe("durable paid route standing", () => {
  test("Headscale denial performs one guard decision and no debit or provider call", async () => {
    requirePaidRouteStanding.mockRejectedValueOnce(standingDenial());

    const response = await tunnelApp.request(
      "/api/v1/apis/tunnels/tailscale/auth-key",
      {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      },
      {
        HEADSCALE_API_URL: "https://headscale.internal",
        HEADSCALE_PUBLIC_URL: "https://headscale.example",
        HEADSCALE_API_KEY: "test-secret",
      },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "Organization is inactive",
      details: { reason: "organization_inactive" },
    });
    expect(requirePaidRouteStanding).toHaveBeenCalledTimes(1);
    expect(deductCredits).not.toHaveBeenCalled();
    expect(createPreAuthKey).not.toHaveBeenCalled();
  });

  test("Headscale failure synchronously refunds the completed debit", async () => {
    createPreAuthKey.mockRejectedValueOnce(new Error("headscale unavailable"));

    const response = await tunnelApp.request(
      "/api/v1/apis/tunnels/tailscale/auth-key",
      {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      },
      {
        HEADSCALE_API_URL: "https://headscale.internal",
        HEADSCALE_PUBLIC_URL: "https://headscale.example",
        HEADSCALE_API_KEY: "test-secret",
      },
    );

    expect(response.status).toBe(500);
    expect(deductCredits).toHaveBeenCalledTimes(1);
    expect(createPreAuthKey).toHaveBeenCalledTimes(1);
    expect(refundCredits).toHaveBeenCalledTimes(1);
  });

  test("credential-broker denial returns the safe reason without provider dispatch", async () => {
    requirePaidRouteStanding.mockRejectedValueOnce(standingDenial());

    const response = await brokerApp.request(
      `/api/v1/connections/${CONNECTION}/broker`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          method: "GET",
          url: "https://api.github.com/user",
        }),
      },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "Organization is inactive",
      details: { reason: "organization_inactive" },
    });
    expect(requirePaidRouteStanding).toHaveBeenCalledTimes(1);
    expect(callProvider).not.toHaveBeenCalled();
  });

  test("credential broker dispatches only after successful standing admission", async () => {
    const response = await brokerApp.request(
      `/api/v1/connections/${CONNECTION}/broker`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          method: "GET",
          url: "https://api.github.com/user",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(requirePaidRouteStanding).toHaveBeenCalledTimes(1);
    expect(callProvider).toHaveBeenCalledWith({
      organizationId: ORG,
      userId: USER,
      connectionId: CONNECTION,
      request: { method: "GET", url: "https://api.github.com/user" },
    });
  });
});
