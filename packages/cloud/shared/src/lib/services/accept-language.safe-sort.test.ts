/**
 * Unit tests for safe sorting of Accept-Language header quality factors.
 */

import { describe, expect, it } from "vitest";

describe("Accept-Language q factor safe sort", () => {
  it("sorts language tags deterministically when quality factor contains NaN", () => {
    const header = "es;q=NaN, en;q=0.8, fr;q=1";
    const ranked = header
      .split(",")
      .map((part) => {
        const [tag, ...params] = part.trim().split(";");
        const q = params
          .map((p) => p.trim())
          .find((p) => p.startsWith("q="))
          ?.slice(2);
        return { tag: tag.trim(), q: q ? Number.parseFloat(q) : 1 };
      })
      .filter((entry) => entry.tag && entry.tag !== "*")
      .sort((a, b) => {
        const bQ = Number.isFinite(b.q) ? b.q : 1;
        const aQ = Number.isFinite(a.q) ? a.q : 1;
        return bQ - aQ || a.tag.localeCompare(b.tag);
      });

    expect(ranked.map((r) => r.tag)).toEqual(["es", "fr", "en"]);
  });
});
