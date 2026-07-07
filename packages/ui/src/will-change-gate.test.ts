/**
 * Source-scanning gate banning permanent `will-change` (it pins a compositor
 * layer and costs memory, #9141). Reads the src tree, no runtime.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #9141 gap #6 — `will-change` promotes an element to a permanent compositor
// layer (extra GPU memory + paint cost that never goes away). It is justified
// only on the handful of surfaces that actually animate transform/opacity every
// frame. This gate fails the build if a new `will-change` creeps onto a static
// element, so the audit stays locked in rather than drifting.
//
// To intentionally add one: animate transform/opacity (not layout), confirm it's
// a hot per-frame surface, and add its src-relative path here with a why.
const ALLOWED = new Set<string>([
  // The sidebar slide/scale animation (transform+opacity+filter, per frame).
  "components/composites/sidebar/sidebar-body.tsx",
  "components/composites/sidebar/sidebar-root.tsx",
  // The continuous-chat sheet: DRAG-SCOPED `will-change: transform` on the
  // panel/thread only while a finger-driven morph (pill↔input↔maximize) or its
  // release spring is live, dropped the instant it settles. Promotes the
  // per-frame transform morph onto its own compositor layer so the frosted
  // glass composites instead of repainting each frame (the installed-PWA
  // micro-stutter) — exactly the justified, non-permanent case.
  "components/shell/ContinuousChatOverlay.tsx",
  // The horizontal home pager rail: the same drag-scoped playbook (#14501) on
  // the horizontal axis — `will-change: transform` set on pointerdown, cleared
  // on settle — so the paged rail transform composites without repainting the
  // notification stack behind it.
  "hooks/useHorizontalPager.ts",
]);

const SRC_ROOT = import.meta.dirname;

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
    } else if (
      /\.(tsx?|css)$/.test(name) &&
      !name.includes(".test.") &&
      !name.includes(".spec.")
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("will-change compositor-layer gate (#9141)", () => {
  it("only the approved animation surfaces declare will-change", () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(SRC_ROOT)) {
      if (/will-change|willChange/.test(readFileSync(file, "utf8"))) {
        const rel = file.slice(SRC_ROOT.length + 1).replace(/\\/g, "/");
        if (!ALLOWED.has(rel)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every allow-listed file still exists and still uses will-change (no stale entries)", () => {
    for (const rel of ALLOWED) {
      const text = readFileSync(join(SRC_ROOT, rel), "utf8");
      expect(/will-change|willChange/.test(text)).toBe(true);
    }
  });
});
