/**
 * Monetization access-control / permissioning assertions.
 *
 * Locks in the audit's verified posture (org-membership gate is solid; no
 * cross-org IDOR) AND regression-guards the two permissioning fixes made
 * alongside these tests:
 *   - the `dev-test-key` superuser bypass was removed from cloud-shared auth
 *   - `docker-nodes/bootstrap-callback` was added to the public-path allowlist
 *     so its own `x-bootstrap-secret` check (not the session gate) governs it.
 */
import { seedTestUser } from "../src/fixtures/seed";
import { authedClient } from "../src/helpers/monetization";
import { expect, test } from "../src/helpers/test-fixtures";

test.describe("monetization permissioning", () => {
  test("cross-org IDOR: another org cannot read/mutate/earn-from your app", async ({
    stack,
    seededUser,
  }) => {
    const api = stack.urls.api;
    const owner = authedClient(api, seededUser.apiKey);

    const created = await owner<{ app?: { id?: string } }>(
      "POST",
      "/api/v1/apps",
      {
        name: `Perm App ${Date.now().toString(36)}`,
        app_url: "https://placeholder.invalid",
        skipGitHubRepo: true,
      },
    );
    expect([200, 201]).toContain(created.status);
    const appId = created.json.app?.id;
    expect(appId).toBeTruthy();

    const attacker = authedClient(
      api,
      (await seedTestUser({ slug: `attacker-${Date.now().toString(36)}` }))
        .apiKey,
    );

    // Read, mutate, earnings, withdraw, monetization — all cross-org denied.
    const get = await attacker("GET", `/api/v1/apps/${appId}`);
    expect(get.status, "cross-org app read denied").toBe(403);

    const patch = await attacker("PATCH", `/api/v1/apps/${appId}`, {
      name: "hijacked",
    });
    expect([403, 404], "cross-org app rename denied").toContain(patch.status);

    const del = await attacker("DELETE", `/api/v1/apps/${appId}`);
    expect([403, 404], "cross-org app delete denied").toContain(del.status);

    const earnings = await attacker("GET", `/api/v1/apps/${appId}/earnings`);
    expect(earnings.status, "cross-org earnings read denied").toBe(403);

    const withdraw = await attacker(
      "POST",
      `/api/v1/apps/${appId}/earnings/withdraw`,
      {
        amount: 25,
      },
    );
    expect([403, 404], "cross-org withdraw denied").toContain(withdraw.status);

    const monetize = await attacker(
      "PUT",
      `/api/v1/apps/${appId}/monetization`,
      {
        monetizationEnabled: true,
        inferenceMarkupPercentage: 999,
      },
    );
    expect(monetize.status, "cross-org monetization change denied").toBe(403);
  });

  test("admin-only routes reject non-admin sessions", async ({ stack }) => {
    const api = stack.urls.api;
    // A fresh non-admin user (role override).
    const nonAdmin = authedClient(
      api,
      (
        await seedTestUser({
          slug: `member-${Date.now().toString(36)}`,
          role: "member",
        })
      ).apiKey,
    );

    for (const path of [
      "/api/admin/redemptions",
      "/api/v1/admin/metrics",
      "/api/v1/admin/users",
    ]) {
      const res = await nonAdmin("GET", path);
      expect([401, 403], `non-admin denied on ${path}`).toContain(res.status);
    }
  });

  test("redemption-processing cron requires the cron secret", async ({
    stack,
  }) => {
    const api = stack.urls.api;

    const noSecret = await fetch(`${api}/api/cron/process-redemptions`, {
      method: "POST",
    });
    expect([401, 403], "cron without secret is denied").toContain(
      noSecret.status,
    );

    const withSecret = await fetch(`${api}/api/cron/process-redemptions`, {
      method: "POST",
      headers: { "x-cron-secret": "test-cron-secret" },
    });
    expect(
      withSecret.status,
      "cron with the correct secret is authorized (no approved redemptions → no-op 200)",
    ).toBe(200);
  });

  test("bootstrap-callback is reachable past the gate and governed by its own secret", async ({
    stack,
  }) => {
    const api = stack.urls.api;
    // No session, no x-bootstrap-secret. Before the fix the global auth gate
    // 401'd this admin path before the handler ran. After the fix the request
    // reaches the route, whose own secret check returns 503 (secret unset in
    // the harness) — NOT a gate 401.
    const res = await fetch(
      `${api}/api/v1/admin/docker-nodes/bootstrap-callback`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(
      res.status,
      "request reaches the route (503 not_configured), not blocked by the gate (401)",
    ).not.toBe(401);
    expect([503, 400]).toContain(res.status);
  });

  test("public + auth-required boundary is correct", async ({
    stack,
    seededUser,
  }) => {
    const api = stack.urls.api;

    // Public: domain resolve answers without auth (404 for an unknown domain).
    const resolve = await fetch(
      `${api}/api/v1/domains/resolve?domain=does-not-exist-${Date.now()}.example`,
    );
    expect(
      resolve.status,
      "public domain resolve is not gate-blocked",
    ).not.toBe(401);

    // Inference endpoints are in the public allowlist but self-authenticate.
    const noAuthInference = await fetch(`${api}/api/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/elizatest",
        max_tokens: 8,
        messages: [],
      }),
    });
    expect(
      [400, 401],
      "inference without auth is rejected by the handler",
    ).toContain(noAuthInference.status);

    // The removed dev-test-key is not a valid credential.
    const devKey = await fetch(`${api}/api/v1/apps`, {
      headers: { "X-API-Key": "dev-test-key" },
    });
    expect(
      devKey.status,
      "dev-test-key is not a credential (bypass removed)",
    ).toBe(401);

    // A real seeded key works on the same route.
    const real = await authedClient(api, seededUser.apiKey)(
      "GET",
      "/api/v1/apps",
    );
    expect(real.status).toBe(200);
  });
});
