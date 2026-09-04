/**
 * Landing header-CTA auth regression (#28743), exercised in a deterministic
 * localhost Playwright harness. This does not prove live staging session,
 * revocation, expiry, or staging/production isolation behavior.
 *
 * The header CTA must stay neutral "Sign in" even when the same-origin
 * homepage session (`localStorage.eliza_app_session`) exists: that key
 * cannot attest the separate Cloud-app origin session, so inferring a
 * Dashboard CTA from it fabricates cross-origin session knowledge. The old
 * heuristic rendered Dashboard here; this spec fails against it.
 *
 * Below 640px the header is hidden by design, so the mobile case additionally
 * opens the user-visible ContactSheet and asserts its account CTA. The
 * session-present desktop case also asserts bearer hygiene: landing must
 * neither send Authorization headers nor persist bearer/JWT-looking values.
 */

import { expect, type Request, test } from "playwright/test";
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
      const authHeaderChecks: Array<Promise<string | null>> = [];
      const recordAuthorization = (request: Request) => {
        authHeaderChecks.push(
          request
            .headerValue("authorization")
            .then((value) => (value === null ? null : request.url())),
        );
      };
      const shouldCheckBearerHygiene =
        viewport.name === "desktop" && session === "present";
      if (shouldCheckBearerHygiene) {
        page.on("request", recordAuthorization);
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

      if (viewport.name === "mobile" && session === "present") {
        // The header (and its CTA) is display:none at this width; the sheet
        // carries the visible account CTA.
        await page
          .getByRole("button", { name: /all the ways to reach eliza/i })
          .click();
        const account = page.locator(".landing-sheet-row--account");
        await expect(account).toBeVisible();
        await expect(account).toContainText(/sign in to eliza cloud/i);
        await expect(account).toHaveAttribute("href", /\/login\?intent=launch/);
      }

      if (shouldCheckBearerHygiene) {
        // The session key must never become a credential: no Authorization
        // header leaves the page, and no bearer/JWT-looking value is stored.
        page.off("request", recordAuthorization);
        const authedUrls = (await Promise.all(authHeaderChecks)).filter(
          (url): url is string => url !== null,
        );
        expect(authedUrls).toEqual([]);
        const storedValues = await page.evaluate(() => {
          const values: string[] = [];
          for (const store of [window.localStorage, window.sessionStorage]) {
            for (let i = 0; i < store.length; i += 1) {
              const key = store.key(i);
              if (key !== null) values.push(store.getItem(key) ?? "");
            }
          }
          return values;
        });
        for (const value of storedValues) {
          expect(value).not.toMatch(/bearer\s+[A-Za-z0-9\-_.~+/=]+/i);
          expect(value).not.toContain("eyJ");
        }
      }
    });
  }
}
