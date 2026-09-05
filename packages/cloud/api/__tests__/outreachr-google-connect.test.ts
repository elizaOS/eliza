/**
 * Exercises the Outreachr managed Google OAuth initiation endpoint.
 * Proves that:
 * 1. Valid requests bind OAuth strictly to the verified principal and bounded capabilities.
 * 2. Unauthenticated, revoked, or wrong-client requests fail fast (401/403).
 * 3. Caller overrides (redirectUrl, side, capabilities, user/org) are ignored/prevented.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import * as agentGoogleConnectorActual from "@/lib/services/agent-google-connector";
import * as delegationAdapterActual from "@/lib/services/outreachr-delegation-adapter";

const mockInitiateManagedGoogle = mock();
mock.module("@/lib/services/agent-google-connector", () => ({
  ...agentGoogleConnectorActual,
  initiateManagedGoogleConnection: mockInitiateManagedGoogle,
}));

const mockAuthorize = mock();
mock.module("@/lib/services/outreachr-delegation-adapter", () => ({
  ...delegationAdapterActual,
  outreachrDelegationService: {
    ...delegationAdapterActual.outreachrDelegationService,
    authorize: mockAuthorize,
  },
}));

const outreachrApp = (await import("../v1/outreachr/route")).default;

const secret = "outreachr-test-client-secret-with-adequate-entropy-32b";
const env = {
  OUTREACHR_APP_ID: randomUUID(),
  OUTREACHR_ORIGIN: "https://outreachr.example.com",
  OUTREACHR_CLIENT_SECRET_SHA256: createHash("sha256")
    .update(secret)
    .digest("hex"),
};

afterAll(() => {
  mock.module(
    "@/lib/services/agent-google-connector",
    () => agentGoogleConnectorActual,
  );
  mock.module(
    "@/lib/services/outreachr-delegation-adapter",
    () => delegationAdapterActual,
  );
});

describe("POST /google/connect", () => {
  beforeEach(() => {
    mockInitiateManagedGoogle.mockClear();
    mockAuthorize.mockClear();
  });

  test("initiates managed Google OAuth bound to the verified principal with fixed capabilities", async () => {
    const userId = randomUUID();
    const organizationId = randomUUID();
    mockAuthorize.mockResolvedValueOnce({
      id: userId,
      organizationId,
      email: "user@example.com",
      name: "Test User",
      emailVerified: true,
    });
    mockInitiateManagedGoogle.mockResolvedValueOnce({
      provider: "google",
      side: "owner",
      mode: "cloud_managed",
      requestedCapabilities: [
        "google.basic_identity",
        "google.calendar.read",
        "google.calendar.write",
        "google.gmail.triage",
        "google.gmail.send",
        "google.gmail.manage",
      ],
      redirectUri: "/auth/success?platform=google",
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=test",
    });

    const res = await outreachrApp.request(
      "http://localhost/google/connect",
      {
        method: "POST",
        headers: {
          "X-Outreachr-Client": secret,
          Authorization:
            "Bearer outreachr_valid_token_123456789012345678901234",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          side: "agent",
          redirectUrl: "https://attacker.com/steal",
          capabilities: ["google.basic_identity"],
        }),
      },
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(body.authUrl).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=test",
    );
    expect(body.redirectUri).toBe("/auth/success?platform=google");

    expect(mockInitiateManagedGoogle).toHaveBeenCalledTimes(1);
    const args = mockInitiateManagedGoogle.mock.calls[0][0];
    expect(args).toEqual({
      organizationId,
      userId,
      side: "owner",
      redirectUrl: "/auth/success?platform=google",
      capabilities: [
        "google.basic_identity",
        "google.calendar.read",
        "google.calendar.write",
        "google.gmail.triage",
        "google.gmail.send",
        "google.gmail.manage",
      ],
    });
  });

  test("rejects unauthenticated requests missing client secret or token", async () => {
    mockAuthorize.mockImplementationOnce(() => {
      const {
        OutreachrDelegationError,
      } = require("@/lib/services/outreachr-delegation");
      throw new OutreachrDelegationError(
        401,
        "OUTREACHR_CLIENT_INVALID",
        "Invalid Outreachr client credentials",
      );
    });

    const res = await outreachrApp.request(
      "http://localhost/google/connect",
      {
        method: "POST",
        headers: {
          "X-Outreachr-Client": "wrong-secret",
        },
      },
      env,
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(false);
    expect(body.code).toBe("OUTREACHR_CLIENT_INVALID");
    expect(mockInitiateManagedGoogle).not.toHaveBeenCalled();
  });

  test("rejects revoked or expired Outreachr delegation credentials (403)", async () => {
    mockAuthorize.mockImplementationOnce(() => {
      const {
        OutreachrDelegationError,
      } = require("@/lib/services/outreachr-delegation");
      throw new OutreachrDelegationError(
        403,
        "OUTREACHR_GRANT_REVOKED",
        "Outreachr delegation credentials have been revoked",
      );
    });

    const res = await outreachrApp.request(
      "http://localhost/google/connect",
      {
        method: "POST",
        headers: {
          "X-Outreachr-Client": secret,
          Authorization:
            "Bearer outreachr_revoked_token_123456789012345678901234",
        },
      },
      env,
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(false);
    expect(body.code).toBe("OUTREACHR_GRANT_REVOKED");
    expect(mockInitiateManagedGoogle).not.toHaveBeenCalled();
  });

  test("translates upstream connector error using standard cloud failure response", async () => {
    const userId = randomUUID();
    const organizationId = randomUUID();
    mockAuthorize.mockResolvedValueOnce({
      id: userId,
      organizationId,
      email: "user@example.com",
      name: "Test User",
      emailVerified: true,
    });
    mockInitiateManagedGoogle.mockImplementationOnce(() => {
      const {
        AgentGoogleConnectorError,
      } = require("@/lib/services/agent-google-connector");
      throw new AgentGoogleConnectorError(
        503,
        "Managed Google OAuth service is temporarily unavailable",
      );
    });

    const res = await outreachrApp.request(
      "http://localhost/google/connect",
      {
        method: "POST",
        headers: {
          "X-Outreachr-Client": secret,
          Authorization:
            "Bearer outreachr_valid_token_123456789012345678901234",
        },
      },
      env,
    );

    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(false);
    expect(body.error).toBe(
      "Managed Google OAuth service is temporarily unavailable",
    );
  });
});
