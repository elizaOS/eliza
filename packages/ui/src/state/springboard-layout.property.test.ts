import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  reconcileLayout,
  SPRINGBOARD_DOCK_LIMIT,
  type SpringboardLayout,
} from "./springboard-layout.js";

// Ids drawn from a small pool so available / favorites / pages overlap (and
// collide / go stale) the way a real catalog churns. Input is deliberately
// messy — cross-page duplicates, favorites that aren't available, etc. — to
// prove reconcileLayout always produces a clean layout regardless.
const arbId = fc.integer({ min: 0, max: 40 }).map((n) => `v${n}`);
const arbAvailable = fc.uniqueArray(arbId, { maxLength: 30 });
const arbLayout: fc.Arbitrary<SpringboardLayout> = fc.record({
  favorites: fc.array(arbId, { maxLength: 8 }),
  pages: fc.array(fc.array(arbId, { maxLength: 10 }), { maxLength: 5 }),
  manual: fc.boolean(),
});
const arbPageSize = fc.integer({ min: 1, max: 25 });

describe("reconcileLayout invariants (property-based)", () => {
  it("always yields a clean, complete, deduped layout", () => {
    fc.assert(
      fc.property(
        arbLayout,
        arbAvailable,
        arbPageSize,
        (layout, available, pageSize) => {
          const out = reconcileLayout(layout, available, pageSize);
          const availableSet = new Set(available);
          const flat = out.pages.flat();
          const placed = [...out.favorites, ...flat];

          // 1. The dock never exceeds the cap.
          expect(out.favorites.length).toBeLessThanOrEqual(
            SPRINGBOARD_DOCK_LIMIT,
          );
          // 2. Everything placed is actually available (no stale ids leak).
          for (const id of placed) {
            expect(availableSet.has(id)).toBe(true);
          }
          // 3. No id appears twice across the dock + pages.
          expect(new Set(placed).size).toBe(placed.length);
          // 4. Every available id is placed exactly once (nothing dropped).
          expect(new Set(placed)).toEqual(availableSet);
          // 5. Favorites and pages are disjoint.
          const favSet = new Set(out.favorites);
          for (const id of flat) expect(favSet.has(id)).toBe(false);
          // 6. No page overflows pageSize, and there are no empty pages (holes).
          for (const page of out.pages) {
            expect(page.length).toBeGreaterThan(0);
            expect(page.length).toBeLessThanOrEqual(pageSize);
          }
          // 7. The manual flag passes through unchanged.
          expect(out.manual).toBe(layout.manual);
        },
      ),
      { numRuns: 300 },
    );
  });
});
