import { expect, test } from "../src/helpers/test-fixtures";

/**
 * Auth contract for an authed endpoint. A *present-but-invalid* API key must
 * yield 401, never 500 — staging was observed returning HTTP 500 on
 * `GET /api/v1/eliza/agents` with a bad bearer, which silently disables the
 * Hetzner real-infra e2e (its preflight treats 5xx as "skip"). This pins the
 * code contract so a regression is caught locally.
 */
test.describe("auth errors", () => {
  const AGENTS = "/api/v1/eliza/agents";

  test("missing credentials → 401", async ({ stack }) => {
    const res = await fetch(`${stack.urls.api}${AGENTS}`);
    expect(res.status).toBe(401);
  });

  test("invalid api-key bearer → 401 (never 500)", async ({ stack }) => {
    const res = await fetch(`${stack.urls.api}${AGENTS}`, {
      headers: { Authorization: "Bearer eliza_totally_invalid_key_000000" },
    });
    expect(
      res.status,
      `invalid key must be rejected with 401, got ${res.status}: ${await res.clone().text()}`,
    ).toBe(401);
  });

  test("malformed (non-eliza) bearer → 401 (never 500)", async ({ stack }) => {
    const res = await fetch(`${stack.urls.api}${AGENTS}`, {
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    expect(res.status).toBe(401);
  });

  test("X-API-Key header with an invalid key → 401 (never 500)", async ({
    stack,
  }) => {
    const res = await fetch(`${stack.urls.api}${AGENTS}`, {
      headers: { "X-API-Key": "eliza_totally_invalid_key_000000" },
    });
    expect(res.status).toBe(401);
  });

  test("a valid seeded api key is accepted", async ({ stack, seededUser }) => {
    const res = await fetch(`${stack.urls.api}${AGENTS}`, {
      headers: { Authorization: `Bearer ${seededUser.apiKey}` },
    });
    expect(
      res.status,
      `valid key should be accepted, got ${res.status}`,
    ).toBeLessThan(300);
  });
});
