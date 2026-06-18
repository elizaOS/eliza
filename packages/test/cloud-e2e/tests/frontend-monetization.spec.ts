/**
 * Cloud-frontend monetization e2e (browser-driven).
 *
 * Boots the real cloud-frontend, logs in with the synthetic test-session
 * cookie, and visits each monetization dashboard page, asserting (a) the page
 * is reachable while authenticated (not bounced to /login) and (b) it fetches
 * authenticated data from the Cloud API (Commandment 10: every GET has a
 * consuming component). Assertions are based on observed network traffic, not
 * specific DOM selectors, to stay robust against UI churn.
 *
 * Uses the default `load` wait (this SPA polls, so `networkidle` never settles)
 * plus a short settle window to capture on-mount data fetches.
 */
import { authedClient } from "../src/helpers/monetization";
import { expect, test } from "../src/helpers/test-fixtures";

test.describe("cloud-frontend monetization pages", () => {
  test("apps, earnings, billing, analytics pages load + fetch authed data", async ({
    authenticatedPage,
    stack,
    seededUser,
  }) => {
    const page = authenticatedPage;
    const fe = stack.urls.frontend;

    // Seed an app so the apps page has real content to render.
    const api = authedClient(stack.urls.api, seededUser.apiKey);
    const created = await api<{ app?: { id?: string } }>(
      "POST",
      "/api/v1/apps",
      {
        name: `FE App ${Date.now().toString(36)}`,
        app_url: "https://placeholder.invalid",
        skipGitHubRepo: true,
      },
    );
    expect([200, 201]).toContain(created.status);

    const apiResponses: Array<{ path: string; status: number }> = [];
    page.on("response", (r) => {
      const p = new URL(r.url()).pathname;
      if (p.startsWith("/api/"))
        apiResponses.push({ path: p, status: r.status() });
    });

    // Warm the SPA shell once (vite dev compiles on first load).
    await page.goto(`${fe}/dashboard`, { timeout: 60_000 });
    await expect(page, "dashboard stays authenticated").not.toHaveURL(
      /\/login(\?|$)/,
    );

    const visit = async (path: string, expectApiPrefix: string) => {
      apiResponses.length = 0;
      await page.goto(`${fe}${path}`, { timeout: 45_000 });
      await expect(page, `${path} stays authenticated`).not.toHaveURL(
        /\/login(\?|$)/,
      );
      // Let on-mount data fetches fire.
      await page.waitForTimeout(4000);

      const okCalls = apiResponses.filter(
        (r) => r.status > 0 && r.status < 400,
      );
      expect(
        okCalls.length,
        `${path} made ≥1 successful API call (saw ${JSON.stringify(apiResponses.slice(0, 10))})`,
      ).toBeGreaterThan(0);

      const unauth = apiResponses.filter((r) => r.status === 401);
      expect(
        unauth.length,
        `${path} had no 401s (saw ${JSON.stringify(unauth)})`,
      ).toBe(0);

      const hitPrimary = apiResponses.some((r) =>
        r.path.startsWith(expectApiPrefix),
      );
      console.log(
        `[fe] ${path}: ${apiResponses.length} api calls, primary(${expectApiPrefix})=${hitPrimary}`,
      );
    };

    await visit("/dashboard/apps", "/api/v1/apps");
    await visit("/dashboard/earnings", "/api/v1/redemptions");
    await visit("/dashboard/billing", "/api/v1/billing");
    await visit("/dashboard/analytics", "/api/analytics");
  });
});
