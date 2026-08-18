/** Exercises malformed and internally failed request decoding with deterministic route collaborators. */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const APP_ID = "00000000-0000-4000-8000-0000000000aa";
const createSession = mock(async () => ({
  id: "cs_1",
  url: "https://checkout.stripe.test/session",
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
    email: "u@example.com",
  }),
}));

mock.module("@/lib/services/apps", () => ({
  appsService: {
    getById: async () => ({
      id: APP_ID,
      name: "demo",
      app_url: "https://app.example.test",
      allowed_origins: [],
    }),
  },
}));

mock.module("@/lib/stripe", () => ({
  requireStripe: () => ({
    checkout: { sessions: { create: createSession } },
  }),
}));

mock.module("@/lib/security/redirect-validation", () => ({
  getDefaultPlatformRedirectOrigins: () => ["https://example.test"],
  assertAllowedAbsoluteRedirectUrl: (url: string) => new URL(url),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { info: () => undefined, error: () => undefined },
}));

const { default: app } = await import("./route");

const validBody = {
  app_id: APP_ID,
  amount: 5,
  success_url: "https://example.test/ok",
  cancel_url: "https://example.test/cancel",
};

describe("POST /api/v1/app-credits/checkout malformed JSON", () => {
  beforeEach(() => {
    createSession.mockClear();
  });

  test("returns 400 instead of 500 and never creates a session", async () => {
    const secret = "checkout-secret-must-not-leak";
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"token":"${secret}`,
    });
    expect(response.status).toBe(400);
    const responseBody = await response.json();
    expect(responseBody).toMatchObject({
      error: "Invalid JSON body",
    });
    expect(JSON.stringify(responseBody)).not.toContain(secret);
    expect(createSession).not.toHaveBeenCalled();
  });

  test("preserves an internal request stream failure as a server error", async () => {
    const request = new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    request.text = async () => {
      throw new TypeError("request stream unavailable");
    };

    const response = await app.fetch(request);

    expect(response.status).toBe(500);
    expect(createSession).not.toHaveBeenCalled();
  });

  test("preserves an internal decoder SyntaxError as a server error", async () => {
    const request = new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    request.text = async () => {
      throw new SyntaxError("internal decoder invariant failed");
    };

    const response = await app.fetch(request);

    expect(response.status).toBe(500);
    expect(createSession).not.toHaveBeenCalled();
  });

  test("canonical JSON still creates a checkout session", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(response.status).toBe(200);
    expect(createSession).toHaveBeenCalled();
  });
});
