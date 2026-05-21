// Every interactive element on every key route must have a visible focus
// outline when reached via keyboard. This catches a common regression
// where designers add `focus:outline-none` without supplying a
// replacement focus ring.
//
// Implementation: for each route, tab through the first 12 focusable
// elements and assert at least one of {outline-width, box-shadow,
// border-color delta} is non-trivial on the focused element.

import { expect, test } from "@playwright/test";
import { loginWithInjectedEthereum } from "./_helpers/siwe-session";

test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "Focus-ring check uses local mocks; skipped in live-prod mode.",
);

const ROUTES: { path: string; auth: boolean }[] = [
  { path: "/login", auth: false },
  { path: "/bsc", auth: false },
  { path: "/dashboard", auth: true },
  { path: "/dashboard/api-keys", auth: true },
  { path: "/dashboard/billing", auth: true },
  { path: "/dashboard/settings", auth: true },
  { path: "/dashboard/agents", auth: true },
];

for (const { path: route, auth } of ROUTES) {
  test(`focus rings visible on ${route}`, async ({ page, context }) => {
    if (auth) {
      await loginWithInjectedEthereum(page, context);
    }
    await page.goto(route);
    await page
      .waitForLoadState("networkidle", { timeout: 6_000 })
      .catch(() => {});
    await page.waitForTimeout(300);

    const missingRing: { tag: string; text: string }[] = [];
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      const result = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const cs = window.getComputedStyle(el);
        const outlineWidth = parseFloat(cs.outlineWidth || "0");
        const boxShadow = cs.boxShadow || "";
        const hasRing =
          outlineWidth >= 1 ||
          (boxShadow !== "none" && boxShadow.length > 0) ||
          // Tailwind's focus:ring uses box-shadow; some primitives use
          // border instead — accept a thick border as a ring stand-in.
          parseFloat(cs.borderTopWidth || "0") >= 2;
        return {
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || el.getAttribute("aria-label") || "")
            .trim()
            .slice(0, 60),
          hasRing,
        };
      });
      if (!result) break;
      if (!result.hasRing) {
        missingRing.push({ tag: result.tag, text: result.text });
      }
    }
    expect(
      missingRing,
      `Interactive elements without a visible focus ring on ${route}:\n${missingRing
        .map((m) => `  <${m.tag}> "${m.text}"`)
        .join("\n")}`,
    ).toEqual([]);
  });
}
