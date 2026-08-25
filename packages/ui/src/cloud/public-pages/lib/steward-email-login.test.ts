/** Verifies steward email sign-in adapter through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Direct Steward email sign-in adapter coverage. These tests pin the HTTP
 * contract separately from the React login surface so SDK drift cannot hide a
 * broken path, and status polling remains session-free.
 */

import { describe, expect, it, vi } from "vitest";
import {
  pollStewardEmailSignInStatus,
  startStewardEmailLogin,
  verifyStewardEmailSignInCode,
} from "./steward-email-login";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("steward email sign-in adapter", () => {
  it("starts an email login challenge through /auth/email/send", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: {
          expiresAt: "2026-07-17T12:10:00.000Z",
          challengeId: "challenge-1",
          pollSecret: "poll-secret",
        },
      }),
    );

    await expect(
      startStewardEmailLogin(
        {
          baseUrl: "https://api.example.test/steward",
          tenantId: "elizacloud",
          fetchImpl,
        },
        "person@example.com",
      ),
    ).resolves.toEqual({
      expiresAt: "2026-07-17T12:10:00.000Z",
      challengeId: "challenge-1",
      pollSecret: "poll-secret",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.example.test/steward/auth/email/send",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({
          email: "person@example.com",
          tenantId: "elizacloud",
        }),
      }),
    );
  });

  it("preserves magic-link-only login during a rolling Steward deployment", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: { expiresAt: "2026-07-17T12:10:00.000Z" },
      }),
    );

    await expect(
      startStewardEmailLogin(
        { baseUrl: "/steward", tenantId: "elizacloud", fetchImpl },
        "person@example.com",
      ),
    ).resolves.toEqual({
      expiresAt: "2026-07-17T12:10:00.000Z",
      challengeId: undefined,
      pollSecret: undefined,
    });
  });

  it("leaves code delivery unknown when the send response does not declare factors", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: {
          expiresAt: "2026-07-17T12:10:00.000Z",
          challengeId: "challenge-1",
          pollSecret: "poll-secret",
        },
      }),
    );

    const challenge = await startStewardEmailLogin(
      { baseUrl: "/steward", tenantId: "elizacloud", fetchImpl },
      "person@example.com",
    );
    // Polling credentials alone never imply an email code was delivered.
    expect(challenge.emailCodeDelivered).toBeUndefined();
  });

  it("parses an explicit deliveredFactors declaration from the send response", async () => {
    const withFactors = (factors: unknown) =>
      vi.fn().mockResolvedValue(
        jsonResponse({
          ok: true,
          data: {
            expiresAt: "2026-07-17T12:10:00.000Z",
            challengeId: "challenge-1",
            pollSecret: "poll-secret",
            deliveredFactors: factors,
          },
        }),
      );

    await expect(
      startStewardEmailLogin(
        {
          baseUrl: "/steward",
          fetchImpl: withFactors(["magic_link", "email_code"]),
        },
        "person@example.com",
      ),
    ).resolves.toMatchObject({ emailCodeDelivered: true });

    await expect(
      startStewardEmailLogin(
        { baseUrl: "/steward", fetchImpl: withFactors(["magic_link"]) },
        "person@example.com",
      ),
    ).resolves.toMatchObject({ emailCodeDelivered: false });

    // A malformed declaration is treated as absent, not as a delivery claim.
    await expect(
      startStewardEmailLogin(
        { baseUrl: "/steward", fetchImpl: withFactors([42]) },
        "person@example.com",
      ),
    ).resolves.toMatchObject({ emailCodeDelivered: undefined });
  });

  it("parses the codeDelivery shorthand from the send response", async () => {
    const withCodeDelivery = (codeDelivery: unknown) =>
      vi.fn().mockResolvedValue(
        jsonResponse({
          ok: true,
          data: {
            expiresAt: "2026-07-17T12:10:00.000Z",
            challengeId: "challenge-1",
            pollSecret: "poll-secret",
            codeDelivery,
          },
        }),
      );

    await expect(
      startStewardEmailLogin(
        { baseUrl: "/steward", fetchImpl: withCodeDelivery("email") },
        "person@example.com",
      ),
    ).resolves.toMatchObject({ emailCodeDelivered: true });

    await expect(
      startStewardEmailLogin(
        { baseUrl: "/steward", fetchImpl: withCodeDelivery("none") },
        "person@example.com",
      ),
    ).resolves.toMatchObject({ emailCodeDelivered: false });

    await expect(
      startStewardEmailLogin(
        { baseUrl: "/steward", fetchImpl: withCodeDelivery("carrier-pigeon") },
        "person@example.com",
      ),
    ).resolves.toMatchObject({ emailCodeDelivered: undefined });
  });

  it("verifies a six-digit companion code and returns the Steward session", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: {
          token: "session-token",
          refreshToken: "refresh-token",
          expiresIn: 900,
          user: { id: "user-1", email: "person@example.com" },
        },
      }),
    );

    await expect(
      verifyStewardEmailSignInCode(
        { baseUrl: "/steward", tenantId: "elizacloud", fetchImpl },
        "person@example.com",
        "123456",
      ),
    ).resolves.toEqual({
      token: "session-token",
      refreshToken: "refresh-token",
      expiresIn: 900,
      user: { id: "user-1", email: "person@example.com" },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "/steward/auth/email/code/verify",
      expect.objectContaining({
        body: JSON.stringify({
          email: "person@example.com",
          code: "123456",
          tenantId: "elizacloud",
        }),
      }),
    );
  });

  it("rejects a successful response that does not satisfy the auth contract", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: { token: "session-token", refreshToken: "refresh-token" },
      }),
    );

    await expect(
      verifyStewardEmailSignInCode(
        { baseUrl: "/steward", tenantId: "elizacloud", fetchImpl },
        "person@example.com",
        "123456",
      ),
    ).rejects.toMatchObject({
      status: 502,
      message: "Steward email sign-in response was malformed.",
    });
  });

  it("normalizes a nested MFA challenge after the response envelope is unwrapped", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: {
          mfaRequired: true,
          mfa: {
            type: "totp",
            challengeId: "mfa-1",
            expiresAt: "2026-07-21T22:00:00.000Z",
          },
          user: { id: "user-1", email: "person@example.com" },
        },
      }),
    );

    await expect(
      verifyStewardEmailSignInCode(
        { baseUrl: "/steward", tenantId: "elizacloud", fetchImpl },
        "person@example.com",
        "123456",
      ),
    ).resolves.toEqual({
      ok: true,
      mfaRequired: true,
      mfa: {
        type: "totp",
        challengeId: "mfa-1",
        expiresAt: "2026-07-21T22:00:00.000Z",
      },
      user: { id: "user-1", email: "person@example.com" },
    });
  });

  it("polls status without returning a session", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ ok: true, data: { status: "consumed" } }),
      );

    await expect(
      pollStewardEmailSignInStatus(
        { baseUrl: "/steward", tenantId: "elizacloud", fetchImpl },
        "challenge-1",
        "poll-secret",
      ),
    ).resolves.toBe("consumed");

    expect(fetchImpl).toHaveBeenCalledWith(
      "/steward/auth/email/status",
      expect.objectContaining({
        body: JSON.stringify({
          challengeId: "challenge-1",
          pollSecret: "poll-secret",
          tenantId: "elizacloud",
        }),
      }),
    );
  });

  it("surfaces honest rate-limit failures", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { error: "Too many email attempts.", code: "rate_limited" },
          429,
        ),
      );

    await expect(
      startStewardEmailLogin(
        { baseUrl: "/steward", tenantId: "elizacloud", fetchImpl },
        "person@example.com",
      ),
    ).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
      message: "Too many email attempts.",
    });
  });
});
