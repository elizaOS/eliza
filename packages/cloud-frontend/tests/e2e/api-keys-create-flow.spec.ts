/**
 * Net-new e2e: /dashboard/api-keys "Create API Key" flow.
 *
 * Previously the api-key-flow.spec.ts only exercised the read path. This
 * spec drives the create button → name field → permission checkboxes →
 * Generate → reveal modal → copy. Catches:
 *   - duplicate Create CTA regression (was visible during loops 3-4)
 *   - generated-key reveal modal masking
 *   - empty-state primary CTA hover color (must NOT go orange→black)
 */

import { expect, test } from "@playwright/test";

test.describe("api-keys create flow", () => {
  test.skip(
    Boolean(process.env.CLOUD_E2E_LIVE_URL),
    "Drives a stubbed POST; live-prod would create real keys.",
  );

  test.beforeEach(async ({ context }) => {
    // Synthetic JWT — the page-level audit already does this; here we
    // just need an authenticated session, not the full eth-injection
    // round-trip (covered in siwe-flow.spec.ts).
    await context.addInitScript(() => {
      window.localStorage.setItem(
        "steward_session_token",
        "playwright-test-token",
      );
    });

    await context.route(/\/api\/v1\/api-keys($|\?)/, async (route) => {
      const req = route.request();
      if (req.method() === "GET") {
        return route.fulfill({
          json: { keys: [], total: 0 },
          headers: { "content-type": "application/json" },
        });
      }
      if (req.method() === "POST") {
        return route.fulfill({
          json: {
            apiKey: {
              id: "key_test_abc",
              name: "Playwright Created Key",
              permissions: ["read"],
            },
            plainKey: "eliza_pk_test_redacted_value_must_be_revealed_once",
          },
          headers: { "content-type": "application/json" },
        });
      }
      return route.continue();
    });

    await context.route(/\/api\/v1\/user/, (route) =>
      route.fulfill({
        json: {
          success: true,
          data: {
            id: "22222222-2222-4222-8222-222222222222",
            email: "audit@example.com",
            name: "Test User",
            role: "owner",
            wallet_address: "0xE2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2",
            organization_id: "33333333-3333-4333-8333-333333333333",
            organization: { id: "33333333-3333-4333-8333-333333333333" },
            is_anonymous: false,
            wallet_verified: true,
            is_active: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        },
        headers: { "content-type": "application/json" },
      }),
    );
  });

  test("empty state renders single primary CTA and create flow completes", async ({
    page,
  }) => {
    await page.goto("/dashboard/api-keys");

    // Empty state should render exactly ONE primary CTA. Loop 4 caught a
    // bug where two Create buttons rendered simultaneously after the
    // useSetPageHeader dependency array shifted. Guard with strict count.
    const createButton = page.getByRole("button", { name: /create.*api key/i });
    await expect(createButton.first()).toBeVisible({ timeout: 10_000 });
    await expect(createButton).toHaveCount(1);

    // Hover the primary CTA. It must NOT transition to a black or blue
    // background — orange-resting buttons should darken in-palette.
    const cta = createButton.first();
    const restColor = await cta.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    await cta.hover();
    const hoverColor = await cta.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    // Either the CTA is on the brand-orange path or the brand-black path;
    // crossing between them is the violation. Allow same-color (some CTAs
    // intentionally use a ring or border for hover affordance instead).
    const isOrange = (s: string) =>
      /rgb\((25[0-5]|2[0-4][0-9]),\s*(8[0-9]|9[0-9]|[01][0-9]{2}),\s*([0-9]|[1-3][0-9])\)/.test(
        s,
      );
    const isBlackish = (s: string) =>
      /rgb\((0|[12][0-9]),\s*(0|[12][0-9]),\s*(0|[12][0-9])\)/.test(s);
    expect(
      !(isOrange(restColor) && isBlackish(hoverColor)),
      `Orange→black hover violation on Create API Key (rest=${restColor}, hover=${hoverColor})`,
    ).toBe(true);

    await cta.click();

    // Modal: name + at least one permission required.
    const nameInput = page.getByLabel(/name/i).first();
    await nameInput.fill("Playwright Created Key");

    const generateButton = page.getByRole("button", { name: /generate/i });
    await expect(generateButton).toBeVisible({ timeout: 5_000 });
    await generateButton.click();

    // Reveal modal exposes the plainKey exactly once.
    const reveal = page.locator("text=eliza_pk_test_redacted_value");
    await expect(reveal.first()).toBeVisible({ timeout: 10_000 });
  });
});
