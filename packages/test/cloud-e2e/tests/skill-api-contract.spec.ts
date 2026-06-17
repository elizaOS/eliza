/**
 * Skill ↔ API contract test.
 *
 * Walks the `eliza-cloud` skill's "Management surface" table and the
 * `build-monetized-app` default flow, hitting each documented endpoint with the
 * documented method + auth against the booted stack. Fails if the skill drifts
 * from reality (wrong path/method/auth), so the skill stays trustworthy.
 *
 * Also pins the drift fixes made alongside this test:
 *   - `apps/{id}/users` is GET-only (POST must 404)
 *   - the documented org-credit and app-credit checkout bodies are accepted
 */
import { seedTestUser } from "../src/fixtures/seed";
import { authedClient } from "../src/helpers/monetization";
import { expect, test } from "../src/helpers/test-fixtures";

/** A documented endpoint must resolve to a real route with working auth. */
function routeExists(status: number): boolean {
  // 404 = no route; 405 = method not allowed; 401 = auth rejected a valid key.
  return status !== 404 && status !== 405 && status !== 401;
}

test.describe("skill ↔ API contract", () => {
  test("every documented management-surface endpoint is reachable as written", async ({
    stack,
  }) => {
    const api = stack.urls.api;
    // Fully-scoped key: some routes (e.g. /api/v1/containers) enforce an
    // explicit API-key scope (`containers:read`); a `*` key exercises the whole
    // documented surface the way a properly-scoped owner key would.
    const owner = await seedTestUser({
      slug: `skill-${Date.now().toString(36)}`,
      permissions: ["*"],
    });
    const c = authedClient(api, owner.apiKey);

    // build-monetized-app: register app
    const created = await c<{ app?: { id?: string }; apiKey?: string }>(
      "POST",
      "/api/v1/apps",
      {
        name: `Contract App ${Date.now().toString(36)}`,
        app_url: "https://placeholder.invalid",
        skipGitHubRepo: true,
      },
    );
    expect([200, 201]).toContain(created.status);
    const appId = created.json.app?.id;
    expect(appId).toBeTruthy();
    if (!appId) throw new Error("apps.create did not return an app id");
    expect(
      created.json.apiKey,
      "create returns the app apiKey (skill flow)",
    ).toBeTruthy();

    // --- Read surface (must be 200) ---
    const list = await c<{ apps?: unknown[]; success?: boolean }>(
      "GET",
      "/api/v1/apps",
    );
    expect(list.status, "list my apps").toBe(200);

    const detail = await c("GET", `/api/v1/apps/${appId}`);
    expect(detail.status, "app details").toBe(200);

    const earnings = await c("GET", `/api/v1/apps/${appId}/earnings`);
    expect(earnings.status, "what are my earnings").toBe(200);

    const analytics = await c("GET", `/api/v1/apps/${appId}/analytics`);
    expect(analytics.status, "show app analytics").toBe(200);

    const containers = await c("GET", "/api/v1/containers");
    expect(containers.status, "list my containers").toBe(200);

    const dashboard = await c("GET", "/api/v1/dashboard");
    expect(dashboard.status, "dashboard overview").toBe(200);

    const redeemBalance = await c("GET", "/api/v1/redemptions/balance");
    expect(redeemBalance.status, "show payout balance").toBe(200);

    // --- The fixed drift: app users is GET-only ---
    const usersGet = await c("GET", `/api/v1/apps/${appId}/users`);
    expect(usersGet.status, "list app users (GET)").toBe(200);
    const usersPost = await c("POST", `/api/v1/apps/${appId}/users`, { x: 1 });
    expect(
      usersPost.status,
      "app users has NO POST (skill corrected to GET-only)",
    ).toBe(404);

    // --- Mutations the skill documents ---
    const rename = await c("PATCH", `/api/v1/apps/${appId}`, {
      description: "renamed via contract test",
    });
    expect(rename.status, "rename/config app").toBe(200);

    const monetization = await c("PUT", `/api/v1/apps/${appId}/monetization`, {
      monetizationEnabled: true,
      inferenceMarkupPercentage: 50,
      purchaseSharePercentage: 10,
    });
    expect(monetization.status, "set markup percentage").toBe(200);

    const affiliate = await c<{
      success?: boolean;
      code?: string;
      affiliate?: { code?: string };
    }>("POST", "/api/v1/affiliates", { markupPercent: 10 });
    expect(affiliate.status, "create affiliate code").toBe(200);

    // --- Endpoints that touch Stripe/registrar/etc: assert the route + auth are
    //     correct (reachable), not the downstream provider result. ---
    const charge = await c("POST", `/api/v1/apps/${appId}/charges`, {
      amount: 5,
      providers: ["stripe"],
    });
    expect(
      routeExists(charge.status),
      `charge user reachable (status ${charge.status})`,
    ).toBe(true);

    const orgCheckout = await c("POST", "/api/v1/credits/checkout", {
      credits: 25,
      success_url: "https://example.com/ok",
      cancel_url: "https://example.com/no",
    });
    expect(
      routeExists(orgCheckout.status),
      `org-credit checkout reachable with documented body (status ${orgCheckout.status})`,
    ).toBe(true);

    const appCheckout = await c("POST", "/api/v1/app-credits/checkout", {
      app_id: appId,
      amount: 25,
      success_url: "https://example.com/ok",
      cancel_url: "https://example.com/no",
    });
    expect(
      routeExists(appCheckout.status),
      `app-credit checkout reachable with documented body (status ${appCheckout.status})`,
    ).toBe(true);

    const tunnel = await c(
      "POST",
      "/api/v1/apis/tunnels/tailscale/auth-key",
      {},
    );
    expect(
      routeExists(tunnel.status),
      `cloud tunnel reachable (status ${tunnel.status})`,
    ).toBe(true);

    // --- Credential rotation + delete (last) ---
    const regen = await c<{
      apiKey?: string;
      api_key?: string;
      success?: boolean;
    }>("POST", `/api/v1/apps/${appId}/regenerate-api-key`);
    expect(regen.status, "regenerate my api key").toBe(200);

    const del = await c("DELETE", `/api/v1/apps/${appId}`);
    expect(del.status, "delete this app").toBe(200);
  });
});
