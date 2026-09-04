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
 * four cases also assert request/storage hygiene. When a synthetic JWT
 * sentinel exists, landing must neither transmit, mutate, nor copy it.
 */

import { expect, type Request, test } from "playwright/test";
import { waitForLandingIntro } from "./landing-readiness";

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;
const SESSION_KEY = "eliza_app_session";
const SESSION_SENTINEL_MARKER = "synthetic-homepage-session-sentinel";
const SESSION_SENTINEL_PAYLOAD =
  "eyJzdWIiOiJzeW50aGV0aWMtaG9tZXBhZ2Utc2Vzc2lvbi1zZW50aW5lbCIsImF1ZCI6ImhvbWVwYWdlLXRlc3QifQ";
const SESSION_SENTINEL_SIGNATURE = "c3ludGhldGljLWludmFsaWQtc2lnbmF0dXJl";
const SESSION_SENTINEL = [
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  SESSION_SENTINEL_PAYLOAD,
  SESSION_SENTINEL_SIGNATURE,
].join(".");
const SESSION_SENTINEL_FRAGMENTS = [
  SESSION_SENTINEL,
  SESSION_SENTINEL_MARKER,
  SESSION_SENTINEL_PAYLOAD,
  SESSION_SENTINEL_SIGNATURE,
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
        await page.addInitScript(
          ({ key, value }) => window.localStorage.setItem(key, value),
          { key: SESSION_KEY, value: SESSION_SENTINEL },
        );
      }
      const requestLeakChecks: Array<
        Promise<{ hasAuthorization: boolean; hasSentinel: boolean }>
      > = [];
      const recordRequestLeak = (request: Request) => {
        requestLeakChecks.push(
          request.allHeaders().then((headers) => {
            const requestParts = [
              request.url(),
              request.postData() ?? "",
              ...Object.values(headers),
            ];
            return {
              hasAuthorization: Object.hasOwn(headers, "authorization"),
              hasSentinel: requestParts.some((part) =>
                SESSION_SENTINEL_FRAGMENTS.some((fragment) =>
                  part.includes(fragment),
                ),
              ),
            };
          }),
        );
      };
      page.on("request", recordRequestLeak);
      try {
        await page.goto("/", { waitUntil: "domcontentloaded" });
        await waitForLandingIntro(page);

        const cta = page.locator(".landing-header-cta");
        await expect(cta).toHaveText(/sign in/i);
        await expect(cta).toHaveAttribute("href", /\/login\?intent=launch/);
        // No inferred Dashboard anywhere on the landing route.
        await expect(page.getByText("Dashboard", { exact: false })).toHaveCount(
          0,
        );

        if (viewport.name === "mobile") {
          // The header (and its CTA) is display:none at this width; the sheet
          // carries the visible account CTA.
          await page
            .getByRole("button", { name: /all the ways to reach eliza/i })
            .click();
          const account = page.locator(".landing-sheet-row--account");
          await expect(account).toBeVisible();
          await expect(account).toContainText(/sign in to eliza cloud/i);
          await expect(account).toHaveAttribute(
            "href",
            /\/login\?intent=launch/,
          );
        }

        // The synthetic token models the three-segment JWT shape used by the
        // homepage, but carries no valid signature or real credential data.
        page.off("request", recordRequestLeak);
        const requestResults = await Promise.all(requestLeakChecks);
        expect(requestResults.length).toBeGreaterThan(0);
        expect(
          requestResults.every(({ hasAuthorization }) => !hasAuthorization),
        ).toBe(true);
        expect(requestResults.every(({ hasSentinel }) => !hasSentinel)).toBe(
          true,
        );
        const storageRows = await page.evaluate(() => {
          const rows: Array<{ store: string; key: string; value: string }> = [];
          for (const [storeName, store] of [
            ["localStorage", window.localStorage],
            ["sessionStorage", window.sessionStorage],
          ] as const) {
            for (let i = 0; i < store.length; i += 1) {
              const key = store.key(i);
              if (key === null) continue;
              const value = store.getItem(key);
              if (value === null) continue;
              rows.push({ store: storeName, key, value });
            }
          }
          return rows.sort(
            (left, right) =>
              left.store.localeCompare(right.store) ||
              left.key.localeCompare(right.key),
          );
        });
        expect(storageRows).toEqual(
          session === "present"
            ? [
                {
                  store: "localStorage",
                  key: SESSION_KEY,
                  value: SESSION_SENTINEL,
                },
              ]
            : [],
        );
      } finally {
        page.off("request", recordRequestLeak);
        await Promise.allSettled(requestLeakChecks);
      }
    });
  }
}
