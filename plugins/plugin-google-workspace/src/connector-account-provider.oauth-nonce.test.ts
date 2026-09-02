/**
 * Verifies that the Google OAuth callback is bound to the OpenID Connect nonce
 * generated for its authorization request. The token exchange is deterministic
 * and mocked; no provider or credential store is contacted.
 */

import type { ConnectorAccountManager } from "@elizaos/core";
import { OAuth2Client } from "google-auth-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoogleConnectorAccountProvider } from "./connector-account-provider.js";
import { GOOGLE_OAUTH_SCOPES } from "./scopes.js";

function signedJwtShape(payload: Record<string, unknown>): string {
  return `${Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString("base64url")}.${Buffer.from(
    JSON.stringify(payload)
  ).toString("base64url")}.`;
}

describe("Google OAuth OIDC nonce binding", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects an ID token whose nonce differs from the authorization flow", async () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: "https://accounts.google.com",
      aud: "client-id",
      iat: now - 10,
      exp: now + 3600,
      sub: "google-subject",
      email: "owner@example.com",
      nonce: "different-nonce",
    };
    vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({
      getPayload: () => payload,
    } as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "access-token",
              expires_in: 3600,
              scope: GOOGLE_OAUTH_SCOPES.gmail.read,
              id_token: signedJwtShape(payload),
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      )
    );

    const provider = createGoogleConnectorAccountProvider({
      getSetting: (key: string) =>
        ({
          GOOGLE_CLIENT_ID: "client-id",
          GOOGLE_CLIENT_SECRET: "client-secret",
          GOOGLE_REDIRECT_URI: "http://127.0.0.1:31437/api/connectors/google/oauth/callback",
        })[key],
      getService: () => null,
    } as never);

    await expect(
      provider.completeOAuth?.(
        {
          provider: "google",
          code: "authorization-code",
          query: {},
          flow: {
            id: "flow-id",
            provider: "google",
            state: "state",
            status: "pending",
            codeVerifier: "verifier",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            metadata: {
              requestedRole: "OWNER",
              requestedCapabilities: ["gmail.read"],
              requestedScopes: [GOOGLE_OAUTH_SCOPES.gmail.read],
              oidcNonce: "expected-nonce",
            },
          },
        },
        { listAccounts: async () => [] } as unknown as ConnectorAccountManager
      )
    ).rejects.toMatchObject({ code: "GOOGLE_OAUTH_NONCE_MISMATCH" });
  });
});
