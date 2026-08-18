/**
 * POST /api/v1/extract untrusted JSON body contract.
 *
 * Hono 4.13 `c.req.json()` is a bare `JSON.parse`. The handler catch maps
 * SyntaxError through `failureResponse` to HTTP 500 instead of a caller 400.
 * Hosted-page extract must not run on client garbage.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const USER_ID = "00000000-0000-4000-8000-0000000000aa";
const ORG_ID = "00000000-0000-4000-8000-0000000000bb";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: USER_ID,
  organization_id: ORG_ID,
}));

const extractHostedPage = mock(async () => {
  throw new Error("extractHostedPage must not run");
});

const logHostedBrowserFailure = mock(() => undefined);

const failureResponse = mock(
  (c: { json: (body: unknown, status: number) => unknown }) =>
    c.json({ success: false, error: "An unexpected error occurred" }, 500),
);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/services/browser-tools", () => ({
  extractHostedPage,
  logHostedBrowserFailure,
}));

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse,
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

const { default: app } = await import("./route");

function post(raw: string) {
  return app.fetch(
    new Request("http://test.local/", {
      method: "POST",
      headers: {
        Authorization: "Bearer eliza_test_key",
        "Content-Type": "application/json",
      },
      body: raw,
    }),
  );
}

describe("POST /api/v1/extract JSON body", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
    extractHostedPage.mockClear();
    logHostedBrowserFailure.mockClear();
    failureResponse.mockClear();
    extractHostedPage.mockImplementation(async () => {
      throw new Error("extractHostedPage must not run");
    });
  });

  test.each(["", "   ", "{", "not-json"])(
    "rejects malformed extract body %j with 400",
    async (raw) => {
      const res = await post(raw);

      expect(res.status).toBe(400);
      expect((await res.json()) as Record<string, unknown>).toEqual({
        success: false,
        error: "Invalid JSON body",
      });
      expect(requireUserOrApiKeyWithOrg).toHaveBeenCalled();
      expect(extractHostedPage).not.toHaveBeenCalled();
      expect(logHostedBrowserFailure).not.toHaveBeenCalled();
      expect(failureResponse).not.toHaveBeenCalled();
    },
  );

  test("still 400s a parseable object missing url via zod", async () => {
    const res = await post("{}");

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Invalid extract request");
    expect(extractHostedPage).not.toHaveBeenCalled();
  });

  test("still extracts a canonical object body", async () => {
    extractHostedPage.mockResolvedValue({
      markdown: "# ok",
      url: "https://example.com",
    });

    const res = await post(JSON.stringify({ url: "https://example.com" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      markdown: "# ok",
      url: "https://example.com",
    });
    expect(extractHostedPage).toHaveBeenCalledTimes(1);
    expect(extractHostedPage.mock.calls[0]?.[0]).toMatchObject({
      url: "https://example.com",
    });
    expect(extractHostedPage.mock.calls[0]?.[1]).toMatchObject({
      organizationId: ORG_ID,
      userId: USER_ID,
      requestSource: "api",
    });
  });
});
