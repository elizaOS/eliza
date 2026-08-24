/** Verifies export authority, confirmation, and non-cacheable response headers. */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const checkElizaMutatingRequestOrigin = mock(() => ({ ok: true }));
const getAccountDeletionExport = mock(async (credential: string) => ({
  bytes: new TextEncoder().encode('{"export":true}'),
  contentDigest: "content-digest",
  filename: credential === "recovery-capability" ? "export.json" : "wrong.json",
}));

class AccountDeletionExportError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

mock.module("@/lib/auth/browser-origin-policy", () => ({
  checkElizaMutatingRequestOrigin,
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { CRITICAL: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) =>
    await next(),
}));
mock.module("@/lib/services/account-deletion-export", () => ({
  AccountDeletionExportError,
  getAccountDeletionExport,
}));

const { default: app } = await import("./route");

beforeEach(() => {
  checkElizaMutatingRequestOrigin.mockReset();
  checkElizaMutatingRequestOrigin.mockReturnValue({ ok: true });
  getAccountDeletionExport.mockClear();
});

describe("/api/public/account-deletion/export", () => {
  test("rejects cross-origin access before touching the capability", async () => {
    checkElizaMutatingRequestOrigin.mockReturnValueOnce({ ok: false });
    const response = await app.request(
      "/",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Account-Deletion-Recovery": "recovery-capability",
        },
        body: JSON.stringify({ confirmation: "EXPORT MY DATA" }),
      },
      { NODE_ENV: "production" },
    );
    expect(response.status).toBe(403);
    expect(getAccountDeletionExport).not.toHaveBeenCalled();
  });

  test("requires exact confirmation before export mutation", async () => {
    const response = await app.request(
      "/",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Account-Deletion-Recovery": "recovery-capability",
        },
        body: JSON.stringify({ confirmation: "export my data" }),
      },
      { NODE_ENV: "test" },
    );
    expect(response.status).toBe(400);
    expect(getAccountDeletionExport).not.toHaveBeenCalled();
  });

  test("returns only verified bytes with no-store and digest headers", async () => {
    const response = await app.request(
      "/",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Account-Deletion-Recovery": "recovery-capability",
        },
        body: JSON.stringify({ confirmation: "EXPORT MY DATA" }),
      },
      { NODE_ENV: "test" },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"export":true}');
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="export.json"',
    );
    expect(response.headers.get("x-account-deletion-export-sha256")).toBe(
      "content-digest",
    );
    expect(getAccountDeletionExport).toHaveBeenCalledWith(
      "recovery-capability",
    );
  });
});
