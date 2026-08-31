/**
 * Exercises X OAuth callback identity binding and fail-closed success
 * projection. Deterministic mocked transport/storage only; no real provider
 * call, credential, or environment mutation.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

let connectionRole: "owner" | "agent" = "owner";
let callOrder: string[] = [];
let tokenResult: {
  accessToken: string;
  refreshToken: string;
  scope: string[];
  expiresAt: number;
  screenName?: string;
  userId?: string;
  identityLookupError?: string | null;
} = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  scope: ["dm.read", "dm.write"],
  expiresAt: 2_000_000_000,
  screenName: "alice",
  userId: "111",
  identityLookupError: null,
};
let exchangeError: Error | null = null;
let successLandingPath = false;
const mintedProofs: unknown[] = [];

const cacheGet = mock(async () => ({
  codeVerifier: "verifier",
  redirectUri: "https://api.example.test/api/v1/twitter/callback",
  organizationId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  connectionRole,
}));
const cacheDel = mock(async () => undefined);
const exchangeOAuth2Token = mock(async () => {
  if (exchangeError) throw exchangeError;
  return tokenResult;
});
const storeCredentials = mock(async () => {
  callOrder.push("store");
});
const linkVerifiedXOwnerIdentity = mock(async () => {
  callOrder.push("link");
});
const mintOAuthSuccessProof = mock(async (args: unknown) => {
  mintedProofs.push(args);
  return "one-time-proof";
});
const isOAuthSuccessLandingPath = mock(() => successLandingPath);

mock.module("@/lib/cache/client", () => ({
  cache: { get: cacheGet, del: cacheDel },
}));
mock.module("@/lib/services/twitter-automation", () => ({
  twitterAutomationService: { exchangeOAuth2Token, storeCredentials },
}));
mock.module("@/lib/services/eliza-app/x-personal-identity", () => ({
  linkVerifiedXOwnerIdentity,
}));
mock.module("@/lib/services/oauth/invalidation", () => ({
  invalidateOAuthState: mock(async () => undefined),
}));
mock.module("@/lib/services/oauth/success-proof", () => ({
  clearOAuthSuccessParams: mock(() => undefined),
  isOAuthSuccessLandingPath,
  mintOAuthSuccessProof,
}));
mock.module("@/lib/security/redirect-validation", () => ({
  getDefaultPlatformRedirectOrigins: () => [],
  LOOPBACK_REDIRECT_ORIGINS: [],
  resolveOAuthSuccessRedirectUrl: () => ({
    target: new URL("https://cloud.eliza.app/cloud/settings?tab=connections"),
    rejected: false,
  }),
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(), warn: mock(), info: mock() },
}));

const { default: route } = await import("./route");
const app = new Hono();
app.route("/api/v1/twitter/callback", route);

function locationUrl(response: Response): URL {
  const location = response.headers.get("location");
  expect(location).toBeTruthy();
  return new URL(location as string);
}

describe("GET /api/v1/twitter/callback", () => {
  beforeEach(() => {
    connectionRole = "owner";
    callOrder = [];
    successLandingPath = false;
    exchangeError = null;
    mintedProofs.length = 0;
    tokenResult = {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      scope: ["dm.read", "dm.write"],
      expiresAt: 2_000_000_000,
      screenName: "alice",
      userId: "111",
      identityLookupError: null,
    };
    linkVerifiedXOwnerIdentity.mockClear();
    storeCredentials.mockClear();
    mintOAuthSuccessProof.mockClear();
  });

  test("links OAuth-verified owner X identity before storing credentials", async () => {
    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/twitter/callback?code=oauth-code&state=oauth-state",
      ),
    );

    expect(response.status).toBe(302);
    expect(linkVerifiedXOwnerIdentity).toHaveBeenCalledWith({
      organizationId: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000002",
      twitterUserId: "111",
    });
    expect(storeCredentials).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["link", "store"]);
    const url = locationUrl(response);
    expect(url.searchParams.get("twitter_connected")).toBe("true");
    expect(url.searchParams.get("twitter_username")).toBe("alice");
    expect(url.searchParams.get("twitter_error")).toBeNull();
  });

  test("does not link an agent-role X identity to the authenticated user", async () => {
    connectionRole = "agent";
    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/twitter/callback?code=oauth-code&state=oauth-state",
      ),
    );

    expect(response.status).toBe(302);
    expect(linkVerifiedXOwnerIdentity).not.toHaveBeenCalled();
    expect(storeCredentials).toHaveBeenCalledTimes(1);
  });

  test("mints a success proof for a verified identity on the success landing path", async () => {
    successLandingPath = true;
    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/twitter/callback?code=oauth-code&state=oauth-state",
      ),
    );
    expect(response.status).toBe(302);
    expect(mintOAuthSuccessProof).toHaveBeenCalledTimes(1);
    expect(locationUrl(response).searchParams.get("proof")).toBe(
      "one-time-proof",
    );
  });

  test("does not emit connected success or a proof when identity lookup failed", async () => {
    successLandingPath = true;
    tokenResult = {
      ...tokenResult,
      screenName: undefined,
      userId: undefined,
      identityLookupError: "profile forbidden: secret-provider-detail-xyz",
    };

    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/twitter/callback?code=oauth-code&state=oauth-state",
      ),
    );

    expect(response.status).toBe(302);
    expect(storeCredentials).toHaveBeenCalledTimes(1);
    expect(linkVerifiedXOwnerIdentity).not.toHaveBeenCalled();
    expect(mintOAuthSuccessProof).not.toHaveBeenCalled();
    const url = locationUrl(response);
    expect(url.searchParams.get("twitter_connected")).toBeNull();
    expect(url.searchParams.get("proof")).toBeNull();
    expect(url.searchParams.get("twitter_warning")).toBeNull();
    expect(url.searchParams.get("twitter_warning_detail")).toBeNull();
    expect(url.searchParams.get("twitter_error_detail")).toBeNull();
    expect(url.searchParams.get("twitter_error")).toBe(
      "provider_identity_verification_failed",
    );
    expect(url.toString()).not.toContain("secret-provider-detail-xyz");
    expect(url.toString()).not.toContain("forbidden");
  });

  test.each([
    { screenName: undefined, userId: "111" },
    { screenName: "alice", userId: undefined },
    { screenName: "", userId: "111" },
    { screenName: "alice", userId: "" },
    { screenName: "   ", userId: "111" },
    { screenName: "alice", userId: "   " },
  ])(
    "does not claim connected success for incomplete identity %j",
    async (identity) => {
      tokenResult = {
        ...tokenResult,
        ...identity,
        identityLookupError: null,
      };
      const response = await app.fetch(
        new Request(
          "https://api.example.test/api/v1/twitter/callback?code=oauth-code&state=oauth-state",
        ),
      );
      expect(storeCredentials).toHaveBeenCalledTimes(1);
      const url = locationUrl(response);
      expect(url.searchParams.get("twitter_connected")).toBeNull();
      expect(url.searchParams.get("twitter_error")).toBe(
        "provider_identity_verification_failed",
      );
      expect(url.searchParams.get("twitter_warning_detail")).toBeNull();
    },
  );

  test("token exchange failures keep provider diagnostics out of the redirect URL", async () => {
    exchangeError = new Error("invalid_grant: secret-provider-detail-xyz");
    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/twitter/callback?code=oauth-code&state=oauth-state",
      ),
    );
    expect(storeCredentials).not.toHaveBeenCalled();
    const url = locationUrl(response);
    expect(url.searchParams.get("twitter_error")).toBe("token_exchange_failed");
    expect(url.searchParams.get("twitter_error_detail")).toBeNull();
    expect(url.toString()).not.toContain("secret-provider-detail-xyz");
    expect(url.toString()).not.toContain("invalid_grant");
  });
});
