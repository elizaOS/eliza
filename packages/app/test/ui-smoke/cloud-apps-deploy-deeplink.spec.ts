/**
 * #10823 shell leg — the Apps Deploy UI is reachable in the app shell via the
 * deep-link navigation intent.
 *
 * `eliza://apps/deploy` (and `https://eliza.app/apps/deploy`) resolve to the
 * `{ viewId: "cloud-apps", viewPath: "/cloud-apps" }` intent
 * (src/deep-link-routing.ts — unit-tested there). This spec proves the OTHER
 * half in a real Chromium shell: dispatching that intent on the
 * `eliza:navigate:view` bus mounts the registered `cloud-apps` app-shell page
 * (NativeAppsStudio → ApplicationsPage → ApplicationDetailPage), all the way to
 * the Deploy/Redeploy control.
 *
 * The `cloud-apps` page registers only on non-web platforms (the web build
 * serves the Applications surfaces via CloudRouterShell), so the Electrobun
 * runtime marker is injected BEFORE boot — the same desktop-platform signal the
 * packaged shell provides (precedent: voice-desktop-selftest.spec.ts). Eliza
 * Cloud API traffic (`https://api.elizacloud.ai/**`) is route-mocked: this lane
 * proves the SHELL wiring; the cloud API contract itself is covered by the
 * packages/ui mock-cloud client e2e and the cloud API's own suites.
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/cloud-apps-deploy-deeplink.spec.ts
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, type Route, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const EVIDENCE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../.github/issue-evidence/8621-mobile-cloud-agent",
);

const APP_ID = "6e0a4f1c-9d2b-4c33-8f0e-5a7b1c2d3e4f";
const APP_NAME = "Deep Link Deploy Proof";

function base64Url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Unsigned-but-decodable Steward JWT (the native studio only decodes claims). */
function fakeStewardJwt(): string {
  const header = base64Url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      sub: "user-deploy-proof",
      userId: "user-deploy-proof",
      email: "qa@example.test",
      exp: 4102444800, // 2100-01-01 — comfortably fresh, no pre-render refresh
    }),
  );
  return `${header}.${payload}.unsigned`;
}

function mockApp(): Record<string, unknown> {
  return {
    id: APP_ID,
    name: APP_NAME,
    description: "ui-smoke fixture app for the #10823 deep-link entry",
    slug: "deep-link-deploy-proof",
    organization_id: "org-1",
    created_by_user_id: "user-deploy-proof",
    app_url: "https://deploy-proof.example.test",
    allowed_origins: ["https://deploy-proof.example.test"],
    api_key_id: "key-1",
    affiliate_code: null,
    referral_bonus_credits: null,
    total_requests: 12,
    total_users: 3,
    total_credits_used: "0",
    logo_url: null,
    website_url: null,
    contact_email: null,
    metadata: {},
    deployment_status: "READY",
    production_url: "https://deploy-proof.apps.elizacloud.ai",
    last_deployed_at: "2026-07-01T00:00:00.000Z",
    github_repo: null,
    linked_character_ids: null,
    monetization_enabled: false,
    inference_markup_percentage: null,
    purchase_share_percentage: null,
    platform_offset_amount: null,
    custom_pricing_enabled: null,
    total_creator_earnings: null,
    total_platform_revenue: null,
    discord_automation: null,
    telegram_automation: null,
    twitter_automation: null,
    promotional_assets: null,
    email_notifications: null,
    response_notifications: null,
    is_active: true,
    is_approved: true,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    last_used_at: "2026-07-01T00:00:00.000Z",
  };
}

async function fulfillJson(
  route: Route,
  status: number,
  body: unknown,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

/** Mock the Eliza Cloud control plane the NativeAppsStudio pages call. */
async function installCloudApiMocks(
  page: Page,
  unmocked: string[],
): Promise<void> {
  await page.route("https://api.elizacloud.ai/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (method === "GET" && path === "/api/v1/apps") {
      await fulfillJson(route, 200, { apps: [mockApp()] });
      return;
    }
    if (method === "GET" && path === `/api/v1/apps/${APP_ID}`) {
      await fulfillJson(route, 200, { app: mockApp() });
      return;
    }
    if (method === "GET" && path === `/api/v1/apps/${APP_ID}/monetization`) {
      // The Overview tab preloads monetization settings alongside the app.
      await fulfillJson(route, 200, {
        success: true,
        monetization: {
          monetization_enabled: false,
          inference_markup_percentage: 0,
          purchase_share_percentage: 0,
          platform_offset_amount: 0,
          custom_pricing_enabled: false,
        },
      });
      return;
    }
    if (method === "GET" && path === `/api/v1/apps/${APP_ID}/deploy/status`) {
      await fulfillJson(route, 200, {
        success: true,
        deploymentId: "dep-1",
        status: "READY",
        vercelUrl: "https://deploy-proof.apps.elizacloud.ai",
        error: null,
        startedAt: "2026-07-01T00:00:00.000Z",
      });
      return;
    }
    unmocked.push(`${method} ${path}`);
    await fulfillJson(route, 404, { error: `unmocked in spec: ${path}` });
  });
}

test.beforeEach(async ({ page }) => {
  // Desktop-platform signal BEFORE boot: registers the `cloud-apps` app-shell
  // page (web builds route Applications through CloudRouterShell instead).
  await page.addInitScript(() => {
    (
      window as unknown as { __electrobunWindowId?: number }
    ).__electrobunWindowId = 1;
  });
  await seedAppStorage(page, { steward_session_token: fakeStewardJwt() });
  await installDefaultAppRoutes(page);
});

test("eliza://apps/deploy intent mounts the Apps studio and reaches the Deploy control", async ({
  page,
}) => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const unmocked: string[] = [];
  await installCloudApiMocks(page, unmocked);

  await openAppPath(page, "/");

  // The exact intent `resolveDeepLinkNavigationIntent("apps/deploy")` produces
  // (unit-locked in packages/app/src/deep-link-routing.test.ts), dispatched on
  // the same bus main.tsx's live deep-link handler uses.
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("eliza:navigate:view", {
        detail: { viewId: "cloud-apps", viewPath: "/cloud-apps" },
      }),
    );
  });

  // Applications list (NativeAppsStudio → ApplicationsPage) with the fixture app.
  const appCard = page.getByText(APP_NAME, { exact: true }).first();
  await expect(appCard).toBeVisible({ timeout: 30_000 });
  await page.screenshot({
    path: `${EVIDENCE_DIR}/cloud-apps-deploy-01-list.png`,
    fullPage: true,
  });

  // Into the detail page — the Overview tab hosts Deploy/Redeploy.
  await appCard.click();
  const deployButton = page
    .getByRole("button", { name: /redeploy|deploy/i })
    .first();
  await expect(deployButton).toBeVisible({ timeout: 30_000 });
  await page.screenshot({
    path: `${EVIDENCE_DIR}/cloud-apps-deploy-02-detail-deploy.png`,
    fullPage: true,
  });

  expect(
    unmocked,
    `cloud API calls the spec did not mock: ${unmocked.join(", ")}`,
  ).toEqual([]);
});
