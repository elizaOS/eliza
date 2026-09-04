/**
 * Landing header-CTA auth regression (#28743).
 *
 * The header CTA must stay neutral "Sign in" even when the same-origin
 * homepage session (`localStorage.eliza_app_session`) exists: that key
 * cannot attest the separate Cloud-app origin session, so inferring a
 * Dashboard CTA from it fabricates cross-origin session knowledge. The old
 * heuristic rendered Dashboard here; this spec fails against it.
 */

import { expect, test } from "playwright/test";
import { waitForLandingIntro } from "./landing-readiness";

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

for (const viewport of VIEWPORTS) {
  for (const session of ["absent", "present"] as const) {
    test(`header CTA stays Sign in at ${viewport.name} with session ${session}`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      if (session === "present") {
        // Homepage login writes this same-origin key; it must not flip the CTA.
        await page.addInitScript(() => {
          window.localStorage.setItem(
            "eliza_app_session",
            JSON.stringify({ user: "cta-regression-probe" }),
          );
        });
      }
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await waitForLandingIntro(page);

      const cta = page.locator(".landing-header-cta");
      await expect(cta).toHaveText(/sign in/i);
      await expect(cta).toHaveAttribute("href", /\/login\?intent=launch/);
      // No inferred Dashboard anywhere on the landing route.
      await expect(page.getByText("Dashboard", { exact: false })).toHaveCount(
        0,
      );
    });
  }
}
