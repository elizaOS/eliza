// Real-browser assertion of the shared ViewHeader contract (#13586 / #13451).
// The `headerPolicy` field on the view registry (ViewHeaderPolicy in
// packages/ui/src/app-shell-registry.ts) declares which views must render the
// shared header, and ViewHeader.test.tsx guards the header's structure over a
// jsdom subtree. This drives the SAME contract against the real rendered app so
// a header-requiring view that drops its shared header — or reintroduces a
// chromed/labelled back button — fails a Playwright sweep, not just the unit
// test. Consumed by all-pages-clicksafe.spec.ts per route.

import { expect, type Page } from "@playwright/test";

/** Stable marker the shared ViewHeader renders (mirrors VIEW_HEADER_TESTID). */
export const VIEW_HEADER_TESTID = "view-header";

/**
 * Assert the swept route renders the shared ViewHeader and that its back
 * control upholds the icon-only contract: exactly one header, a back button
 * that is present, accessible-labelled, and ICON-ONLY (no visible text label —
 * the #13451/#13586 chromeless back affordance), with a ≥44px touch target when
 * `requireTapTarget` is set (the mobile-nav-bar minimum). The header title is
 * centered by construction (an absolutely-positioned `<h1>`), so this asserts
 * the title element is present rather than re-measuring centering (the unit
 * ViewHeader.test.tsx owns the pixel-centering guard).
 */
export async function assertSharedViewHeaderContract(
  page: Page,
  {
    requireTapTarget = false,
    within,
    title,
  }: { requireTapTarget?: boolean; within?: string; title?: string } = {},
): Promise<void> {
  // A route can float its view over the ambient home, so the page may carry
  // more than one `view-header` — an unscoped .first() could assert the
  // AMBIENT header and mask a routed view that lost its own. Callers scope by
  // the routed view's shell (`within`) or by the header's own title text
  // (`title`) so the assertion binds to the routed view's header.
  const scoped = within
    ? page.locator(within).getByTestId(VIEW_HEADER_TESTID)
    : page.getByTestId(VIEW_HEADER_TESTID);
  const header = (title ? scoped.filter({ hasText: title }) : scoped).first();
  await expect(
    header,
    "a normal view must render the shared ViewHeader ([data-testid=view-header])",
  ).toBeVisible({ timeout: 30_000 });

  // The back control: an icon-only button. It carries an aria-label (for a11y +
  // agent addressability) but renders NO visible text — a text label would mean
  // the old chromed back affordance regressed.
  const back = header.getByRole("button").first();
  await expect(
    back,
    "the shared ViewHeader exposes a back control",
  ).toBeVisible();
  await expect(
    back,
    "the back control is accessible-labelled (aria-label)",
  ).toHaveAttribute("aria-label", /.+/);
  const backText = ((await back.textContent()) ?? "").trim();
  expect(
    backText,
    `the shared back button must be icon-only (no visible text label), got "${backText}"`,
  ).toBe("");

  if (requireTapTarget) {
    // The BUTTON's own box is the hit target (h-11 w-11 with a 36px visual
    // chip inside — ViewBackButton). Measure the button, no borrowing from
    // surrounding rows and no clamping: a shrunken control must fail here.
    const box = await back.boundingBox();
    expect(box, "the back control has a measurable box").not.toBeNull();
    if (box) {
      expect(
        box.height,
        `the back control's own tap target is at least 44px tall (got ${box.height})`,
      ).toBeGreaterThanOrEqual(44);
      expect(
        box.width,
        `the back control's own tap target is at least 44px wide (got ${box.width})`,
      ).toBeGreaterThanOrEqual(44);
    }
  }
}

/**
 * Click the shared ViewHeader back control and assert the app did not crash
 * (no page error, #root still present). Back always lands somewhere valid — the
 * launcher grid by default, or a sub-view's hub — so this asserts survival + a
 * URL change away from the current route rather than a specific destination.
 */
export async function clickViewHeaderBack(
  page: Page,
  { within }: { within?: string } = {},
): Promise<void> {
  const header = within
    ? page.locator(within).getByTestId(VIEW_HEADER_TESTID).first()
    : page.getByTestId(VIEW_HEADER_TESTID).first();
  await expect(header).toBeVisible({ timeout: 30_000 });
  const back = header.getByRole("button").first();
  const urlBefore = page.url();
  await back.click();
  // The shell must survive the back navigation.
  await expect(page.locator("#root")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(
    /(?:404\s+not\s+found|page not found|route not found)/i,
  );
  // Back navigated somewhere: either the URL changed or the header is gone
  // (dismissed to a headerless surface like the launcher).
  await expect
    .poll(
      async () =>
        page.url() !== urlBefore ||
        (await page.getByTestId(VIEW_HEADER_TESTID).count()) === 0,
      {
        timeout: 15_000,
        message: "the back control navigates away from the view",
      },
    )
    .toBe(true);
}
