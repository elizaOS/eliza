/**
 * Source-level guard for the SAFE-AREA FILL INVARIANT (see the big comment on
 * the shell root in App.tsx). Every view must fill edge-to-edge UNDER the notch
 * while content stays notch-aware. That works because:
 *   1. the shell root reserves the notch via `paddingTop: var(--safe-area-top)`
 *      (so content is pushed below the notch), and
 *   2. the background layers (`app-opaque-background` underlay + the shared
 *      AppBackground wallpaper + the settings scrim) are `fixed inset-0`, so they
 *      anchor to the VIEWPORT and paint the full notch band — NOT the padded box.
 *
 * The whole guarantee collapses the instant the shell root acquires a property
 * that establishes a containing block for `position: fixed` descendants
 * (transform / filter / backdrop-filter / perspective / will-change / paint or
 * layout `contain`). Then the fixed layers anchor to the padded root box
 * (top = safe-area-top) and an unfilled band re-appears under the notch (the
 * WKWebView host color — brand orange — shows through). This test fails CI if
 * any of those properties creep onto the root, or if a background layer stops
 * being `fixed inset-0`. Scans App.tsx source, no runtime.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const APP_SRC = readFileSync(join(here, "App.tsx"), "utf8");

// The root reserves a tightened status-bar inset derived from --safe-area-top.
// We locate the root by its paddingTop style; the value is allowed to shrink the
// safe area, but the notch-awareness (a --safe-area-top-derived top inset) must
// remain.
const SAFE_AREA_MARKER = "max(calc(var(--safe-area-top";

// Tailwind / CSS tokens that establish a containing block for fixed descendants.
const CONTAINING_BLOCK_TOKENS = [
  "transform",
  "scale-",
  "rotate-",
  "translate-",
  "skew-",
  "filter",
  "blur",
  "brightness-",
  "contrast-",
  "saturate-",
  "backdrop-",
  "perspective",
  "will-change",
  "contain-",
];

/** className of the opening <div> tag that carries the given marker substring. */
function classNameOfElementContaining(marker: string): string {
  const markerIdx = APP_SRC.indexOf(marker);
  expect(markerIdx, `marker not found in App.tsx: ${marker}`).toBeGreaterThan(
    -1,
  );
  const openIdx = APP_SRC.lastIndexOf("<div", markerIdx);
  const closeIdx = APP_SRC.indexOf(">", markerIdx);
  expect(openIdx).toBeGreaterThan(-1);
  expect(closeIdx).toBeGreaterThan(markerIdx);
  const tag = APP_SRC.slice(openIdx, closeIdx + 1);
  const match = tag.match(/className=\{?\s*["'`]([^"'`]*)["'`]/);
  expect(
    match,
    `no string className on element containing ${marker}`,
  ).toBeTruthy();
  return (match as RegExpMatchArray)[1];
}

describe("App safe-area fill invariant", () => {
  it("keeps the shell root notch-aware (content padded by safe-area-top)", () => {
    expect(APP_SRC).toContain(SAFE_AREA_MARKER);
  });

  it("shell root never establishes a containing block for the fixed bg layers", () => {
    const cls = classNameOfElementContaining(SAFE_AREA_MARKER);
    for (const token of CONTAINING_BLOCK_TOKENS) {
      expect(
        cls.includes(token),
        `shell root className must not contain "${token}" — it would make the root the containing block for the fixed inset-0 background layers, re-opening an unfilled band under the notch. className: "${cls}"`,
      ).toBe(false);
    }
  });

  it("shell root inline style sets only paddingTop (no transform/filter/contain)", () => {
    const idx = APP_SRC.indexOf(SAFE_AREA_MARKER);
    const styleStart = APP_SRC.lastIndexOf("style={{", idx);
    const styleEnd = APP_SRC.indexOf("}}", idx);
    const style = APP_SRC.slice(styleStart, styleEnd);
    for (const bad of [
      "transform",
      "filter",
      "perspective",
      "willChange",
      "contain",
      "backdropFilter",
    ]) {
      expect(
        style.includes(bad),
        `shell root inline style must not set ${bad}`,
      ).toBe(false);
    }
  });

  it("opaque app-background underlay fills the viewport (fixed inset-0)", () => {
    const cls = classNameOfElementContaining(
      'data-testid="app-opaque-background"',
    );
    expect(cls).toContain("fixed");
    expect(cls).toContain("inset-0");
  });

  it("shared-background scrim fills the viewport (fixed inset-0)", () => {
    const cls = classNameOfElementContaining(
      'data-testid="app-background-scrim"',
    );
    expect(cls).toContain("fixed");
    expect(cls).toContain("inset-0");
    expect(cls).toContain("bg-black/50");
    expect(cls).not.toContain("bg-bg/55");
  });
});
