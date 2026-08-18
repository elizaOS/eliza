/**
 * Exercises the X connect request boundary with a real Hono route and mocked
 * authentication, OAuth, cache, and redirect collaborators.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const generateAuthLink = mock(
  async (_callbackUrl: string, _role: "agent" | "owner") => ({
    flow: "oauth2" as const,
    url: "https://twitter.com/i/oauth2/authorize",
    state: "state-1",
    codeVerifier: "verifier",
    redirectUri: "https://cloud.eliza.app/api/v1/twitter/callback",
  }),
);
const isConfigured = mock(() => true);
const cacheSet = mock(async () => undefined);

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg: async () => ({
    user: { id: "user-1", organization_id: "org-1" },
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
  failureResponse: (
    c: { json: (body: unknown, status: number) => Response },
    error: unknown,
  ) =>
    c.json(
      {
        error: "internal_error",
        message: error instanceof Error ? error.message : String(error),
      },
      500,
    ),
}));

const route = (await import("./route")).default;
const app = new Hono().route("/api/v1/twitter/connect", route);

function postRaw(body?: string) {
  return app.request("/api/v1/twitter/connect", {
    method: "POST",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body,
  });
}

function post(body?: unknown) {
  return postRaw(body === undefined ? undefined : JSON.stringify(body));
}

describe("POST /api/v1/twitter/connect request validation", () => {
  beforeEach(() => {
    generateAuthLink.mockClear();
    isConfigured.mockClear();
    cacheSet.mockClear();
    isConfigured.mockReturnValue(true);
  });

  test.each([
    [undefined, "owner"],
    [{}, "owner"],
    [{ connectionRole: "" }, "owner"],
    [{ connectionRole: "owner" }, "owner"],
    [{ connectionRole: "agent" }, "agent"],
  ] as const)("accepts %j with role %s", async (body, role) => {
    const response = await post(body);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ connectionRole: role });
    expect(generateAuthLink).toHaveBeenCalledTimes(1);
    expect(generateAuthLink.mock.calls[0]?.[1]).toBe(role);
  });

  test.each(["AGENT", "Owner", "foo", "agent ", "owner\n", 1])(
    "rejects connectionRole=%j",
    async (connectionRole) => {
      const response = await post({ connectionRole });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: "invalid_connection_role",
      });
      expect(generateAuthLink).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["non-object JSON", []],
    ["invalid redirect type", { redirectUrl: 42 }],
  ])("rejects %s", async (_label, body) => {
    const response = await post(body);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_request_body",
    });
    expect(generateAuthLink).not.toHaveBeenCalled();
  });

  test("rejects malformed JSON", async () => {
    const response = await postRaw("{");
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: "invalid_request_body",
      message: "Request body must be valid JSON.",
    });
    expect(generateAuthLink).not.toHaveBeenCalled();
  });
});
