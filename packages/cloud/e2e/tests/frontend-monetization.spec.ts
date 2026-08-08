/**
 * Cloud-frontend monetization e2e (browser-driven).
 *
 * Boots the real cloud web app, logs in with the synthetic test-session
 * cookie, and:
 * (a) visits each standalone monetization dashboard page, asserting it is
 *     reachable while authenticated (not bounced to /login) and fetches
 *     authenticated data from the Cloud API (Commandment 10: every GET has a
 *     consuming component). Assertions are based on observed network traffic,
 *     not specific DOM selectors, to stay robust against UI churn.
 * (b) asserts the account-management deep links (billing / earnings /
 *     monetization) resolve to their canonical console page instead of
 *     dead-ending on the dashboard/* 404. Since #13410 those surfaces ARE
 *     standalone `dashboard/*` routes — that is what makes the apex console
 *     (elizacloud.ai) usable, where the agent app and its in-app Settings view
 *     never boot — so billing/monetization resolve in place and only the legacy
 *     spellings (earnings, settings?tab=) ride a CloudRouterShell compat
 *     redirect (see packages/ui/src/cloud/register-all.test.ts, which pins both
 *     halves: the standalone mounts and the redirect-only legacy spellings).
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
      // Wait deterministically for the page's first successful on-mount API
      // fetch instead of a blind fixed sleep — the sleep raced a transient
      // dev-server page close ("waitForTimeout: Target page... closed"). Armed
      // before navigation so it can't miss the response.
      const firstApiCall = page
        .waitForResponse(
          (r) => {
            const p = new URL(r.url()).pathname;
            return p.startsWith("/api/") && r.status() > 0 && r.status() < 400;
          },
          { timeout: 30_000 },
        )
        .catch(() => null);
      await page.goto(`${fe}${path}`, { timeout: 45_000 });
      await expect(page, `${path} stays authenticated`).not.toHaveURL(
        /\/login(\?|$)/,
      );
      await firstApiCall;
      // Brief settle so sibling fetches firing alongside the first are captured;
      // tolerate a transient page close (assert on whatever was captured).
      await page.waitForTimeout(750).catch(() => {});

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
    await visit("/dashboard/analytics", "/api/analytics");

    // Account-management surfaces are standalone console pages (#13410).
    // Billing / monetization resolve in place, keeping their query string;
    // only the legacy spellings ride a CloudRouterShell compat redirect —
    // `earnings` folded into the tabbed monetization page, and the
    // backend-issued `dashboard/settings?tab=<x>` return URLs map onto the
    // matching console page with the query preserved. None may land on the
    // cloud 404.
    const landings: Array<[from: string, to: RegExp]> = [
      ["/dashboard/billing", /\/dashboard\/billing$/],
      [
        "/dashboard/billing?canceled=true",
        /\/dashboard\/billing\?canceled=true$/,
      ],
      ["/dashboard/earnings", /\/dashboard\/monetization$/],
      ["/dashboard/monetization", /\/dashboard\/monetization$/],
      ["/dashboard/settings?tab=billing", /\/dashboard\/billing\?tab=billing$/],
    ];
    for (const [from, to] of landings) {
      await page.goto(`${fe}${from}`, { timeout: 45_000 });
      await expect(page, `${from} lands on its console page`).toHaveURL(to);
      await expect(page, `${from} stays authenticated`).not.toHaveURL(
        /\/login(\?|$)/,
      );
      // A URL assertion alone cannot tell a mounted console page from the
      // shell's own 404 (CloudRouterShell renders CloudNotFound in place, at
      // the same URL), so an unregistered route would still "land" here.
      // Pin the rendered surface too.
      await expect(
        page.getByRole("heading", { name: "Not found" }),
        `${from} renders its console page, not the cloud 404`,
      ).toBeHidden();
    }
  });
});
