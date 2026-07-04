/**
 * Gate asserting the overscroll-behavior CSS contract (no rubber-band bleed).
 * Reads the stylesheet, no runtime.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for the macOS trackpad two-finger swipe-back / swipe-forward
 * navigation gesture in the desktop (Electrobun) webview.
 *
 * The gesture is a browser-native back/forward navigation that drives the app's
 * History API view navigation through the `popstate` listener in
 * `state/startup-phase-hydrate.ts`. In webviews, a blanket
 * `overscroll-behavior: none` on the scroll-root ALSO sets `-x: none`, which
 * suppresses that swipe-to-navigate gesture. The root `html, body` rule must
 * therefore relax the X axis (`overscroll-behavior-x: auto`) while keeping the
 * Y axis locked (`overscroll-behavior-y: none`) to preserve the vertical
 * rubber-band / pull-to-refresh suppression the rule was originally added for.
 *
 * Native mobile shells intentionally re-lock BOTH axes via the
 * higher-specificity `body.native { overscroll-behavior: none }` rule in
 * base.css — that lock must stay in place.
 */
function readStyle(name: string): string {
  const raw = readFileSync(
    fileURLToPath(new URL(`./${name}`, import.meta.url)),
    "utf8",
  );
  // Strip CSS comments so their prose (which may contain `}` or the literal
  // `overscroll-behavior: none` while explaining the rule) can't confuse the
  // brace-matching or the assertions below.
  return raw.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Extract the first CSS declaration block whose selector list matches
 * `selector`. Called only from inside `it()` bodies so an exact-string
 * selector mismatch (CSS formatting drift) reports as a named test failure
 * instead of a describe-collection error.
 */
function ruleBody(css: string, selector: string): string {
  const idx = css.indexOf(selector);
  expect(idx, `selector \`${selector}\` not found`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", idx);
  const close = css.indexOf("}", open);
  expect(open).toBeGreaterThanOrEqual(0);
  expect(close).toBeGreaterThan(open);
  return css.slice(open + 1, close);
}

function stylesRootBody(): string {
  return ruleBody(readStyle("styles.css"), "html,\nbody");
}

describe("styles.css root scroll-root overscroll-behavior", () => {
  it("relaxes the X axis so the desktop swipe-to-navigate gesture works", () => {
    expect(stylesRootBody()).toMatch(/overscroll-behavior-x:\s*auto/);
  });

  it("keeps the Y axis locked to preserve vertical bounce/pull-to-refresh suppression", () => {
    expect(stylesRootBody()).toMatch(/overscroll-behavior-y:\s*(none|contain)/);
  });

  it("does NOT use a blanket `overscroll-behavior: none` on the scroll-root (it would kill the swipe gesture)", () => {
    expect(stylesRootBody()).not.toMatch(/overscroll-behavior:\s*none/);
  });
});

describe("base.css native shell keeps both overscroll axes locked", () => {
  it("still locks overscroll-behavior on native (body.native) shells", () => {
    const nativeBody = ruleBody(
      readStyle("base.css"),
      "body.native,\nbody.platform-ios,\nbody.platform-android",
    );
    expect(nativeBody).toMatch(/overscroll-behavior:\s*none/);
  });
});
