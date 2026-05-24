/**
 * Contact-sheet screenshot capture.
 *
 * This spec is intentionally separate from aesthetic-audit.spec.ts: it
 * exists to produce *faithful* full-page renderings for visual review,
 * which means it
 *
 *   - waits long enough for animation-heavy routes (/leaderboard) to settle,
 *   - does NOT mask <video> elements (Playwright fills masks with magenta
 *     by default, which destroys the brand visual on the marketing hero),
 *   - and writes its captures into a sibling directory so the aesthetic
 *     audit's own snapshots remain untouched.
 *
 * Run via `bun --cwd packages/homepage run test:audit`; the contact-sheet
 * generator picks up the captures from `test-results/contact-sheet/<vp>/`.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "playwright/test";
import { captureScreenshotWithQualityRetry } from "./screenshot-quality";

const TEST_TOKEN = "homepage-contact-sheet-token";

const ROUTES = [
  { path: "/", name: "landing", authed: false },
  { path: "/leaderboard", name: "leaderboard", authed: false },
  { path: "/get-started", name: "get-started", authed: false },
  { path: "/login", name: "login", authed: true },
  { path: "/connected", name: "connected", authed: true },
] as const;

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

// Write into the aesthetic artifact directory so the unchanged
// generate-contact-sheet.mjs script picks these up. This spec is sequenced
// to run *after* aesthetic-audit.spec.ts in `test:audit`, so its faithful
// renders overwrite the asserter's snapshots before the contact sheet is
// composed.
const ARTIFACT_DIR = path.resolve(process.cwd(), "test-results/aesthetic");

const mockUser = {
  id: "user_contact_sheet",
  telegram_id: "1",
  telegram_username: "contact_sheet_user",
  telegram_first_name: "Contact",
  discord_id: null,
  discord_username: null,
  discord_global_name: null,
  discord_avatar_url: null,
  whatsapp_id: null,
  whatsapp_name: null,
  phone_number: "+15555550100",
  name: "Contact Sheet User",
  avatar: null,
  organization_id: "org_contact_sheet",
  created_at: "2026-01-01T00:00:00.000Z",
};

async function installCloudMocks(page: Page) {
  await page.route("https://www.elizacloud.ai/api/eliza-app/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/eliza-app/user/me") {
      return route.fulfill({
        json: {
          user: mockUser,
          organization: {
            id: "org_contact_sheet",
            name: "Contact Sheet Org",
            credit_balance: "12.34",
          },
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: "Unhandled mock" } });
  });
}

async function seedAuthed(page: Page) {
  await page.addInitScript((token) => {
    window.localStorage.setItem("eliza_app_session", token as string);
  }, TEST_TOKEN);
}

mkdirSync(ARTIFACT_DIR, { recursive: true });

for (const viewport of VIEWPORTS) {
  test.describe(`contact sheet — ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const route of ROUTES) {
      test(`${route.name}`, async ({ page }) => {
        test.setTimeout(90_000);
        await installCloudMocks(page);
        if (route.authed) await seedAuthed(page);

        await page.goto(route.path, { waitUntil: "networkidle" });
        await page.evaluate(() => document.fonts.ready);
        // The App-level Suspense fallback is just an orange <main> with a
        // spinner. Wait for the *real* page chrome (a <header> element)
        // before screenshotting, so we don't capture the loading state.
        await page
          .waitForSelector("header", { timeout: 20_000 })
          .catch(() => {});
        // /leaderboard runs a ~1800ms intro animation. Wait it out.
        if (route.path === "/leaderboard") {
          await page.waitForTimeout(2400);
        } else {
          await page.waitForTimeout(600);
        }

        await captureScreenshotWithQualityRetry(
          page,
          `${viewport.name} ${route.name}`,
          {
            path: path.join(ARTIFACT_DIR, viewport.name, `${route.name}.png`),
            fullPage: true,
            // Mask only genuinely non-deterministic UI. Keep <video> visible
            // so the marketing hero shows its poster image instead of the
            // Playwright default magenta mask fill.
            mask: [
              page.locator(".animate-pulse"),
              page.locator(".animate-spin"),
              page.locator("[data-marquee]"),
            ],
            animations: "disabled",
          },
        );

        await expect(page.locator("body")).toBeVisible();
      });
    }
  });
}
