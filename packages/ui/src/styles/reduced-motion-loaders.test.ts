/**
 * Regression guard: reduced-motion must not freeze functional loading spinners.
 *
 * `styles.css` ships the standard universal reduced-motion reset
 * (`@media (prefers-reduced-motion: reduce) { *, ::before, ::after {
 * animation-duration: 0.01ms !important } }`). That reset is correct for
 * decorative motion, but with no exemption it also collapses loading spinners /
 * progress bars to a single 0.01ms frame — so for any user with OS/browser
 * "Reduce Motion" enabled, every spinner freezes and the app looks hung / broken
 * with no loading feedback (reported live on prod, nubsontopgang@gmail.com).
 *
 * The fix re-enables the small functional loaders inside the same media query.
 * This test pins that exemption so the reset can't silently swallow it again on
 * a future edit — the failure is only observable in a real browser under
 * reduce-motion, so nothing else in CI catches its removal.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(here, "styles.css");
const css = readFileSync(cssPath, "utf8");

/** Extract the body of the universal `prefers-reduced-motion: reduce` block. */
function reducedMotionBlock(): string {
  const start = css.indexOf("@media (prefers-reduced-motion: reduce)");
  expect(
    start,
    "styles.css must contain a reduced-motion media block",
  ).toBeGreaterThanOrEqual(0);
  // Walk braces from the media query open to its matching close.
  const open = css.indexOf("{", start);
  let depth = 0;
  let i = open;
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return css.slice(open, i + 1);
}

describe("reduced-motion functional-loader exemption", () => {
  const block = reducedMotionBlock();

  it("still applies the universal reset (accessibility intent preserved)", () => {
    expect(block).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
  });

  it("exempts .animate-spin so loading spinners keep animating under reduce-motion", () => {
    // The exemption must both target the spinner AND restore an infinite,
    // non-collapsed duration — otherwise the spinner still freezes.
    expect(block, "reduced-motion block must re-enable .animate-spin").toMatch(
      /\.animate-spin/,
    );
    expect(
      block,
      "exempted loaders must run infinitely, not a single 0.01ms frame",
    ).toMatch(/animation-iteration-count:\s*infinite\s*!important/);
    expect(
      block,
      "exempted loaders must have a real (non-collapsed) duration",
    ).toMatch(/animation-duration:\s*(?!0\.01ms)[^;]+!important/);
  });

  it("keeps ARIA progress indicators animating too", () => {
    expect(block).toMatch(/\[role="progressbar"\]/);
  });
});
