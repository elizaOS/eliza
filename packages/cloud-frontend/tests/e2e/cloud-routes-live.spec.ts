// Live production smoke. Hits the real elizacloud.ai (or whatever
// CLOUD_E2E_LIVE_URL points at) with no API mocks. This is what catches
// real bugs that mock-everything specs cannot — hydration errors, schema
// drift, broken endpoints, page-title regressions, missing assets.
//
// Skipped by default. Enable by setting CLOUD_E2E_LIVE_URL.
//   CLOUD_E2E_LIVE_URL=https://www.elizacloud.ai \
//     bunx playwright test --config tests/e2e -g "live:"

import { expect, type Page, test } from "@playwright/test";

const LIVE_URL = process.env.CLOUD_E2E_LIVE_URL;

test.describe("live: public routes against real backend", () => {
  test.skip(
    !LIVE_URL,
    "set CLOUD_E2E_LIVE_URL to enable (e.g. https://www.elizacloud.ai)",
  );

  test.use({ baseURL: LIVE_URL });

  // Only public, idempotent routes. Auth + writes never belong in a live
  // smoke — they would either need real credentials or hit production data.
  const publicRoutes = [
    "/",
    "/login",
    "/docs",
    "/bsc",
    "/privacy-policy",
    "/terms-of-service",
  ];

  const HOMEPAGE_TITLE_FALLBACK = /eliza cloud - Your Eliza, always online/i;
  const ALLOWED_CONSOLE_NOISE: RegExp[] = [/favicon/i, /\/__telemetry__/i];
  const ALLOWED_NETWORK_NOISE: RegExp[] = [
    /\/__telemetry__/i,
    // GA / Posthog / Sentry beacons fail in headless without consent banners
    /google-analytics|googletagmanager|posthog|sentry\.io/i,
  ];

  interface Captured {
    pageErrors: string[];
    consoleErrors: string[];
    failedResponses: Array<{ url: string; status: number }>;
  }

  function collect(page: Page): Captured {
    const c: Captured = {
      pageErrors: [],
      consoleErrors: [],
      failedResponses: [],
    };
    page.on("pageerror", (e) => c.pageErrors.push(e.message ?? String(e)));
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const t = msg.text();
      if (ALLOWED_CONSOLE_NOISE.some((r) => r.test(t))) return;
      c.consoleErrors.push(t);
    });
    page.on("response", (resp) => {
      const status = resp.status();
      if (status < 400) return;
      if (ALLOWED_NETWORK_NOISE.some((r) => r.test(resp.url()))) return;
      c.failedResponses.push({ url: resp.url(), status });
    });
    return c;
  }

  for (const route of publicRoutes) {
    test(`live: ${route} loads clean`, async ({ page }) => {
      const captured = collect(page);
      const resp = await page.goto(route, { waitUntil: "networkidle" });
      expect(resp, `no response for ${route}`).not.toBeNull();
      expect(resp!.status(), `bad status on ${route}`).toBeLessThan(400);

      // Settle SSR-hydrated content
      await page.waitForTimeout(1500);

      const title = await page.title();
      if (route !== "/") {
        expect(title, `${route} fell back to homepage title`).not.toMatch(
          HOMEPAGE_TITLE_FALLBACK,
        );
      }

      const problems: string[] = [];
      if (captured.pageErrors.length) {
        problems.push(
          `Page errors:\n${captured.pageErrors.map((e) => "  - " + e).join("\n")}`,
        );
      }
      if (captured.consoleErrors.length) {
        problems.push(
          `Console errors:\n${captured.consoleErrors.map((e) => "  - " + e).join("\n")}`,
        );
      }
      if (captured.failedResponses.length) {
        problems.push(
          `Failed responses:\n${captured.failedResponses
            .map((f) => `  - ${f.status} ${f.url}`)
            .join("\n")}`,
        );
      }
      if (problems.length) {
        throw new Error(`Real bugs on ${route}:\n\n${problems.join("\n\n")}`);
      }
    });
  }
});
