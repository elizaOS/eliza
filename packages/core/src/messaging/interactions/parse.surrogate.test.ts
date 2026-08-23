/**
 * Behavioral coverage for task-title truncation in findInteractionRegions:
 * packages/core runs Vitest under Node, so this file must import vitest — not
 * bun:test, which cannot resolve in that harness.
 */
import { describe, expect, it } from "vitest";

import { findInteractionRegions, MAX_TASK_TITLE_LEN } from "./parse.ts";
import { toWellFormedUnicode, truncateWellFormed } from "../../utils/well-formed.ts";

describe("parse surrogate-safe task title truncation", () => {
  it("raw slice at max-1 splits a surrogate pair, truncateWellFormed does not", () => {
    // MAX_TASK_TITLE_LEN = 200, truncation cut is at 199 code units.
    // Build a title where the 199th code unit is a high surrogate.
    // "a".repeat(198) occupies 198, then 𝄞 (U+1D11E) occupies 2 units (D834 DD1E).
    const boundaryTitle = "a".repeat(MAX_TASK_TITLE_LEN - 2) + "𝄞" + "b".repeat(50);
    expect(boundaryTitle.length).toBeGreaterThan(MAX_TASK_TITLE_LEN);

    const rawCut = boundaryTitle.slice(0, MAX_TASK_TITLE_LEN - 1);
    // Raw slice lands on the lead half of the surrogate pair.
    expect(rawCut.length).toBe(MAX_TASK_TITLE_LEN - 1);
    // Must be lone surrogate -> not well-formed.
    expect((rawCut as unknown as { isWellFormed?: () => boolean }).isWellFormed?.call(rawCut) ?? (() => {
      // Fallback when engine lacks isWellFormed: check lone surrogate directly
      const last = rawCut.charCodeAt(rawCut.length - 1);
      return !(last >= 0xd800 && last <= 0xdbff);
    })()).toBe(false);
    // Also verify via JSON lone-surrogate signal: JSON.stringify emits \ud834 escape for lone high surrogate
    expect(rawCut.charCodeAt(rawCut.length - 1)).toBe(0xd834);

    const safeCut = truncateWellFormed(boundaryTitle, MAX_TASK_TITLE_LEN - 1);
    expect(safeCut.isWellFormed?.() ?? toWellFormedUnicode(safeCut) === safeCut).toBe(true);
    expect(safeCut.length).toBeLessThanOrEqual(MAX_TASK_TITLE_LEN - 1);
    // backs off by one so no lone surrogate
    expect(safeCut.charCodeAt(safeCut.length - 1)).not.toBe(0xd834);
    const safeTitle = `${safeCut}…`;
    expect(safeTitle.length).toBeLessThanOrEqual(MAX_TASK_TITLE_LEN);
    expect(toWellFormedUnicode(safeTitle) === safeTitle).toBe(true);
  });

  it("findInteractionRegions truncates task titles without creating lone surrogates", () => {
    const emojiTitle = "a".repeat(MAX_TASK_TITLE_LEN - 2) + "😀" + "c".repeat(50);
    const threadId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const text = `[TASK:${threadId}]${emojiTitle}[/TASK]`;
    const regions = findInteractionRegions(text);
    expect(regions.length).toBe(1);
    const block = regions[0].block as { kind: string; title: string };
    expect(block.kind).toBe("task");
    expect(block.title.length).toBeLessThanOrEqual(MAX_TASK_TITLE_LEN);
    expect(block.title.endsWith("…")).toBe(true);
    // Well-formed: no lone surrogate
    expect(toWellFormedUnicode(block.title) === block.title).toBe(true);
    // Native isWellFormed when available
    const isWellFormed = (block.title as unknown as { isWellFormed?: () => boolean }).isWellFormed;
    if (typeof isWellFormed === "function") {
      expect(block.title.isWellFormed()).toBe(true);
    }
  });

  it("emoji at exact boundary does not produce invalid JSON", () => {
    const title = "x".repeat(MAX_TASK_TITLE_LEN - 2) + "𝄞" + "y".repeat(10);
    const cut = truncateWellFormed(title, MAX_TASK_TITLE_LEN - 1) + "…";
    // JSON.stringify on well-formed text never emits lone surrogate escapes
    const json = JSON.stringify({ title: cut });
    expect(json).not.toContain("\\ud834");
    expect(json).not.toContain("\\udd1e");
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
