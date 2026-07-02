import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type LauncherLayout, reconcileLayout } from "./launcher-layout.js";

// Ids drawn from a small pool so available / pages overlap (and collide / go
// stale) the way a real catalog churns. Input is deliberately messy —
// cross-page duplicates, ids that aren't available, etc. — to prove
// reconcileLayout always produces a clean layout regardless.
const arbId = fc.integer({ min: 0, max: 40 }).map((n) => `v${n}`);
const arbAvailable = fc.uniqueArray(arbId, { maxLength: 30 });
const arbLayout: fc.Arbitrary<LauncherLayout> = fc.record({
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

          // 1. Everything placed is actually available (no stale ids leak).
          for (const id of flat) {
            expect(availableSet.has(id)).toBe(true);
          }
          // 2. No id appears twice in the page grid.
          expect(new Set(flat).size).toBe(flat.length);
          // 3. Every available id is represented exactly once across the pages.
          expect(new Set(flat)).toEqual(availableSet);
          // 4. No page overflows pageSize, and there are no empty pages (holes).
          for (const page of out.pages) {
            expect(page.length).toBeGreaterThan(0);
            expect(page.length).toBeLessThanOrEqual(pageSize);
          }
          // 5. The manual flag passes through unchanged.
          expect(out.manual).toBe(layout.manual);
        },
      ),
      { numRuns: 300 },
    );
  });
});
