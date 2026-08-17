/**
 * POST /api/v1/twitter/connect `connectionRole` is owner-vs-agent
 * identity, leftover tax after twitter-status (#21151) /
 * twitter-disconnect (#21144) / x-dms-digest (#21143). Stock develop
 * collapsed a failed ConnectBody.safeParse to {} and the ternary then
 * mapped every non-"agent" token onto the personal owner OAuth
 * connect. The documented default remains owner; garbage must 400
 * before generateAuthLink. redirectUrl stays untouched.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const generateAuthLink = mock(async () => ({
  flow: "oauth2" as const,
  url: "https://twitter.com/i/oauth2/authorize",
  state: "state-1",
  codeVerifier: "verifier",
  redirectUri: "https://cloud.eliza.app/api/v1/twitter/callback",
}));
const isConfigured = mock(() => true);
const cacheSet = mock(async () => undefined);

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg: async () => ({
    user: {
      id: "user-1",
      organization_id: "org-1",
    },
  }),
}));
mock.module("@/lib/services/twitter-automation", () => ({
  twitterAutomationService: { generateAuthLink, isConfigured },
}));
mock.module("@/lib/cache/client", () => ({
  cache: { set: cacheSet },
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
  logger: {
    warn: () => undefined,
    info: () => undefined,
    error: () => undefined,
  },
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (c: { json: (body: unknown, status: number) => Response }) =>
    c.json({ error: "internal_error" }, 500),
}));

const route = (await import("./route")).default;
const app = new Hono().route("/api/v1/twitter/connect", route);

function post(body: Record<string, unknown> | undefined) {
  return app.request("/api/v1/twitter/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("POST /api/v1/twitter/connect connectionRole identity", () => {
  beforeEach(() => {
    generateAuthLink.mockClear();
    isConfigured.mockClear();
    cacheSet.mockClear();
    isConfigured.mockReturnValue(true);
  });

  test.each([
    [{}, "owner"],
    [{ connectionRole: "" }, "owner"],
    [{ connectionRole: "owner" }, "owner"],
    [{ connectionRole: "agent" }, "agent"],
  ])("accepts %j as %s", async (body, role) => {
    const response = await post(body);
    expect(response.status).toBe(200);
    const json = (await response.json()) as { connectionRole: string };
    expect(json.connectionRole).toBe(role);
    expect(generateAuthLink).toHaveBeenCalledTimes(1);
    expect(generateAuthLink.mock.calls[0]?.[1]).toBe(role);
  });

  test.each(["AGENT", "Owner", "foo", "1e2", "agent ", "owner\n", 1])(
    "rejects connectionRole=%j before generateAuthLink",
    async (token) => {
      const response = await post({ connectionRole: token });
      expect(response.status).toBe(400);
      const json = (await response.json()) as { error: string };
      expect(json.error).toMatch(/connection_role|connectionRole/i);
      expect(generateAuthLink).not.toHaveBeenCalled();
    },
  );
});
