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

  /**
   * Identity check: the seeded API key must resolve to the seeded user + org.
   * The task asked for `GET /api/v1/auth/me`, but that route does not exist and
   * `/api/users/me` is session-only (requireUser). The real API-key-authed
   * identity surface is `GET /api/organizations/members`
   * (requireUserOrApiKeyWithOrg; admin/owner only — the seed creates role
   * "admin"). The seeded user is the sole member, so its id/email confirm the
   * key resolved to the seeded identity, and a 200 confirms the org scope.
   * Source: organizations/members/route.ts:21-45, fixtures/seed.ts:54-97.
   */
  test("the seeded api key resolves to the seeded identity", async ({
    stack,
    seededUser,
  }) => {
    const res = await fetch(`${stack.urls.api}/api/organizations/members`, {
      headers: { Authorization: `Bearer ${seededUser.apiKey}` },
    });
    expect(
      res.status,
      `members returned ${res.status}: ${await res.clone().text()}`,
    ).toBe(200);
    const body = (await res.json()) as {
      success?: boolean;
      data?: Array<{ id: string; email: string | null; role: string | null }>;
    };
    expect(body.success).toBe(true);
    const self = body.data?.find((member) => member.id === seededUser.userId);
    expect(
      self,
      "seeded user must appear in its own org membership",
    ).toBeTruthy();
    expect(self?.email).toBe(seededUser.email);
    expect(self?.role).toBe("admin");
  });
});
