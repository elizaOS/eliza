// Every interactive element on every key route must have a visible focus
// outline when reached via keyboard. This catches a common regression
// where designers add `focus:outline-none` without supplying a
// replacement focus ring.
//
// Implementation: for each route, tab through the first 12 focusable
// elements and assert at least one of {outline-width, box-shadow,
// border-color delta} is non-trivial on the focused element.
//
// Auth strategy: dashboard routes use a synthetic JWT token injected
// directly into localStorage + an eliza-test-auth cookie (same pattern
// as cross-page-hover-audit.spec.ts). This avoids the full SIWE flow
// which is slow, requires mocked endpoints, and is fragile under rapid
// tab-through timing.

import { expect, test } from "@playwright/test";

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

function buildSyntheticToken(): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
    "utf8",
  )
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const payload = Buffer.from(
    JSON.stringify({
      sub: "11111111-1111-4111-8111-111111111111",
      userId: "11111111-1111-4111-8111-111111111111",
      address: "0xF1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1",
      email: "focus-rings-test@example.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    }),
    "utf8",
  )
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${header}.${payload}.focus-rings-fake-signature`;
}

for (const { path: route, auth } of ROUTES) {
  test(`focus rings visible on ${route}`, async ({ page, context }) => {
    if (auth) {
      const syntheticToken = buildSyntheticToken();
      await context.addCookies([
        {
          name: "eliza-test-auth",
          value: "1",
          domain: "127.0.0.1",
          path: "/",
          httpOnly: false,
          secure: false,
          sameSite: "Lax",
        },
      ]);
      await context.addInitScript((t: string) => {
        window.localStorage.setItem("steward_session_token", t);
      }, syntheticToken);
      // Mock dashboard API calls so auth routes load without a real backend.
      await context.route(/\/api\/v1\//, (r) =>
        r.fulfill({
          json: {},
          headers: { "content-type": "application/json" },
        }),
      );
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
