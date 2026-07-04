/**
 * Playwright hardening tests for hostile route inputs and browser history restoration.
 */

import { expect, type Page, test } from "playwright/test";

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message ?? String(error)));
  return errors;
}

test("get-started ignores hostile query/hash values and remains usable", async ({
  page,
}) => {
  // /get-started mounts live Cloud-API provisioning + a lazy WebGL shader + the
  // external telegram-widget script; under parallel CI contention page bring-up
  // can exceed the 30s default. The assertions are correct — give it headroom.
  test.setTimeout(90_000);
  const errors = collectPageErrors(page);
  await page.addInitScript(() => {
    (window as Window & { __homepageXssHit?: boolean }).__homepageXssHit =
      false;
  });

  const hostileUrl = `/get-started?${new URLSearchParams({
    method: `"><script>window.__homepageXssHit=true</script>`,
    guide: "javascript:alert(1)",
    link: "TRUE",
    lang: "<img src=x onerror=alert(1)>",
    onboardingSession: "../connected",
  }).toString()}#%3Cimg%20src=x%20onerror=alert(1)%3E`;

  await page.goto(hostileUrl, { waitUntil: "domcontentloaded" });

  await expect(
    page.getByRole("heading", { name: "Anywhere you want her to be." }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^WhatsApp$/ })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Discord Setup Guide" }),
  ).toHaveCount(0);
  await expect(
    page.getByText(/Authentication failed: invalid state/i),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { __homepageXssHit?: boolean }).__homepageXssHit,
      ),
    )
    .toBe(false);

  await page.getByRole("button", { name: /^WhatsApp$/ }).click();
  await expect(
    page.getByRole("heading", { name: "Chat on WhatsApp!" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(
    page.getByRole("heading", { name: "Anywhere you want her to be." }),
  ).toBeVisible();

  expect(errors).toEqual([]);
});

test("browser back and forward restore hash and query driven route views", async ({
  page,
}) => {
  // Same live-API + WebGL marketing surfaces as above; headroom over the 30s
  // default for slow keyless CI bring-up.
  test.setTimeout(90_000);
  const errors = collectPageErrors(page);

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: /^Your Eliza, everywhere\.$/ }),
  ).toBeVisible();

  await page
    .getByRole("link", { name: /^Download$/ })
    .first()
    .click();
  await expect(page).toHaveURL(/#download$/);
  await expect(
    page.getByRole("heading", { name: /^Install the app\.$/ }),
  ).toBeVisible();

  await page.goto("/get-started?method=imessage#ignored", {
    waitUntil: "domcontentloaded",
  });
  await expect(
    page.getByRole("heading", { name: "Ready to chat!" }),
  ).toBeVisible();

  await page.goBack({ waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/#download$/);
  await expect(
    page.getByRole("heading", { name: /^Install the app\.$/ }),
  ).toBeVisible();

  await page.goForward({ waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/get-started\?method=imessage#ignored$/);
  await expect(
    page.getByRole("heading", { name: "Ready to chat!" }),
  ).toBeVisible();

  expect(errors).toEqual([]);
});
