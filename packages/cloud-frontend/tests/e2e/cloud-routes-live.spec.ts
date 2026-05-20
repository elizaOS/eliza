// Live production smoke. Hits the real elizacloud.ai (or whatever
// CLOUD_E2E_LIVE_URL points at) with no API mocks. This is what catches
// real bugs that mock-everything specs cannot — hydration errors, schema
// drift, broken endpoints, page-title regressions, missing assets.
//
// Skipped by default. Enable by setting CLOUD_E2E_LIVE_URL.
//   CLOUD_E2E_LIVE_URL=https://www.elizacloud.ai \
//     bunx playwright test --config tests/e2e -g "live:"

import { expect, type Page, test } from "@playwright/test";
import { readdirSync, statSync } from "node:fs";
import pathModule from "node:path";
import { fileURLToPath } from "node:url";

const LIVE_URL = process.env.CLOUD_E2E_LIVE_URL;
const MIN_NON_BLANK_SCREENSHOT_BYTES = 1_000;
const HERE = pathModule.dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = pathModule.resolve(HERE, "../../content");

function discoverDocsRoutes(): string[] {
  const routes: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const fullPath = pathModule.join(dir, entry);
      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.endsWith(".mdx")) continue;
      const rel = pathModule
        .relative(CONTENT_DIR, fullPath)
        .replace(/\\/g, "/")
        .replace(/\.mdx$/, "");
      if (rel === "index") {
        routes.push("/docs");
      } else if (rel.endsWith("/index")) {
        routes.push(`/docs/${rel.slice(0, -"/index".length)}`);
      } else {
        routes.push(`/docs/${rel}`);
      }
    }
  };
  walk(CONTENT_DIR);
  return [...new Set(routes)].sort();
}

const docsRoutes = discoverDocsRoutes();

test.describe("live: public routes against real backend", () => {
  test.skip(
    !LIVE_URL,
    "set CLOUD_E2E_LIVE_URL to enable (e.g. https://www.elizacloud.ai)",
  );

  test.use({ baseURL: LIVE_URL });

  // Only public, idempotent routes. Authenticated dashboards, payment IDs, and
  // write flows are covered by dedicated live-auth/API specs.
  const publicRoutes = [
    "/",
    "/os",
    "/blog",
    "/login",
    ...docsRoutes,
    "/bsc",
    "/privacy-policy",
    "/terms-of-service",
    "/sandbox-proxy",
    "/auth/success?platform=github",
    "/auth/error?reason=auth_failed",
    "/auth/callback/email",
    "/invite/accept",
  ];

  const HOMEPAGE_TITLE_FALLBACK = /eliza cloud - Your Eliza, always online/i;
  const ALLOWED_CONSOLE_NOISE: RegExp[] = [
    /favicon/i,
    /\/__telemetry__/i,
    /^\[RenderTelemetry\]/,
  ];
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

  async function expectVisibleRouteContent(page: Page) {
    const main = page.locator("main").first();
    if ((await main.count()) > 0) {
      await expect(main).toBeVisible();
      return;
    }
    await expect(page.locator("#root")).toBeVisible();
  }

  for (const route of publicRoutes) {
    test(`live: ${route} loads clean`, async ({ page }) => {
      const captured = collect(page);
      const resp = await page.goto(route, { waitUntil: "networkidle" });
      expect(resp, `no response for ${route}`).not.toBeNull();
      expect(resp?.status(), `bad status on ${route}`).toBeLessThan(400);

      // Settle SSR-hydrated content
      await page.waitForTimeout(1500);
      await expectVisibleRouteContent(page);
      await expect(
        page.getByRole("heading", { name: /^Page Not Found$/i }),
      ).toHaveCount(0);
      const screenshot = await page.screenshot({ fullPage: true });
      expect(screenshot.length).toBeGreaterThan(MIN_NON_BLANK_SCREENSHOT_BYTES);

      const title = await page.title();
      if (route !== "/") {
        expect(title, `${route} fell back to homepage title`).not.toMatch(
          HOMEPAGE_TITLE_FALLBACK,
        );
      }

      const problems: string[] = [];
      if (captured.pageErrors.length) {
        problems.push(
          `Page errors:\n${captured.pageErrors.map((e) => `  - ${e}`).join("\n")}`,
        );
      }
      if (captured.consoleErrors.length) {
        problems.push(
          `Console errors:\n${captured.consoleErrors.map((e) => `  - ${e}`).join("\n")}`,
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

  test("live: /checkout redirects to elizaOS checkout", async ({ page }) => {
    await page.goto("/checkout?collection=elizaos-hardware", {
      waitUntil: "domcontentloaded",
    });
    await expect(page).toHaveURL(
      "https://elizaos.ai/checkout?collection=elizaos-hardware",
    );
  });
});
