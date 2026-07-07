/**
 * Guard for the sign-in surface safe-area contract (#15361).
 *
 * On the installed iOS standalone PWA the login view rendered a black band at
 * the top (the `--launch-bg` FOUC guard showing through the status-bar zone)
 * PLUS a pushed-down card. Two facts drive the fix:
 *
 *   1. The `body.desktop { padding-top: env(safe-area-inset-top) }` rule the
 *      issue suspected is Electrobun-DESKTOP only (added by
 *      `initializeDesktopShell()`); it is NOT present on the installed iOS PWA.
 *      The standalone-PWA CSS blocks (base.css / styles.css) apply the
 *      scroll-lock + height geometry but NO body-level top safe-area padding.
 *   2. This `/login` route renders through `CloudRouterShell` (a public route),
 *      NOT the `App.tsx` catch-all shell column — so it does NOT inherit the
 *      shell column's `paddingTop: max(calc(var(--safe-area-top)..))`.
 *
 * So the login page is the SINGLE owner of the top inset on its own surface.
 * The correct shape is therefore:
 *   - EXACTLY ONE `env(safe-area-inset-top)` inset (the content padding), and
 *   - a `fixed inset-0` `bg-bg` underlay so the background fills edge-to-edge
 *     under the status bar (no black band) instead of a collapsed
 *     `min-h-[100dvh]` slab that starts at the layout-viewport top.
 *
 * This is a source-level scan (jsdom cannot resolve `env()` / device viewport
 * collapse), matching the established App.safe-area-fill.test.ts idiom.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const LOGIN_SRC = readFileSync(join(here, "login-page.tsx"), "utf8");

describe("login page safe-area (#15361)", () => {
  it("applies env(safe-area-inset-top) exactly once on the login surface", () => {
    const matches = LOGIN_SRC.match(/env\(safe-area-inset-top/g) ?? [];
    expect(
      matches.length,
      "the login surface must own the TOP inset exactly once (no double-count vs a body-level inset)",
    ).toBe(1);
  });

  it("applies env(safe-area-inset-bottom) exactly once on the login surface", () => {
    const matches = LOGIN_SRC.match(/env\(safe-area-inset-bottom/g) ?? [];
    expect(
      matches.length,
      "the login surface must own the BOTTOM inset exactly once (audit both edges)",
    ).toBe(1);
  });

  it("fills the background with a fixed inset-0 underlay so no black band shows under the status bar", () => {
    // The bg fill must be viewport-anchored (fixed inset-0), not an in-flow
    // min-h-[100dvh] slab that collapses above the status bar on iOS standalone.
    expect(
      /pointer-events-none fixed inset-0[^"]*bg-bg/.test(LOGIN_SRC),
      "expected a `fixed inset-0 ... bg-bg` underlay on the login surface",
    ).toBe(true);
  });

  it("does not put the opaque bg fill on a min-h-[100dvh] in-flow slab (the collapsed-viewport black-band shape)", () => {
    // Guard against reintroducing `min-h-[100dvh] bg-bg` on the outer wrapper,
    // which is exactly what left the status-bar band unpainted on device.
    expect(
      /min-h-\[100dvh\][^"]*\bbg-bg\b/.test(LOGIN_SRC),
      "the bg-bg fill must not sit on a min-h-[100dvh] in-flow wrapper",
    ).toBe(false);
  });
});
