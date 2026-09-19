/**
 * Exercises X OAuth callback identity binding with mocked transport/storage,
 * proving only a verified owner-role connection links personal DM identity.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

let connectionRole: "owner" | "agent" = "owner";
let callOrder: string[] = [];
const cacheGet = mock(async () => ({
  codeVerifier: "verifier",
  redirectUri: "https://api.example.test/api/v1/twitter/callback",
  organizationId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  connectionRole,
}));
const cacheDel = mock(async () => undefined);
const exchangeOAuth2Token = mock(async () => ({
  accessToken: "access-token",
  refreshToken: "refresh-token",
  scope: ["dm.read", "dm.write"],
  expiresAt: 2_000_000_000,
  screenName: "alice",
  userId: "111",
  identityLookupError: null,
}));
const storeCredentials = mock(async () => {
  callOrder.push("store");
});
const linkVerifiedXOwnerIdentity = mock(async () => {
  callOrder.push("link");
});

const cacheClientActualModule = await import("@/lib/cache/client");

mock.module("@/lib/cache/client", () => ({
  ...cacheClientActualModule,
  cache: {
    get: cacheGet,
    del: cacheDel,
    delConfirmed: async () => true,
    delPatternConfirmed: async () => true,
  },
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
  isOAuthSuccessLandingPath: mock(() => false),
  mintOAuthSuccessProof: mock(async () => null),
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

describe("GET /api/v1/twitter/callback", () => {
  beforeEach(() => {
    connectionRole = "owner";
    callOrder = [];
    linkVerifiedXOwnerIdentity.mockClear();
    storeCredentials.mockClear();
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
});
