/**
 * goalSimilarity feeds the near-duplicate spawn guard. Non-Latin goals must
 * tokenize on their own words, not collapse to the few ASCII tokens they share.
 */

import { describe, expect, it } from "vitest";
import { goalSimilarity } from "../actions/tasks.ts";

const THRESHOLD = 0.6;

describe("goalSimilarity", () => {
  it("keeps distinct Korean goals on the same repo below the duplicate threshold", () => {
    expect(
      goalSimilarity(
        "eliza 레포에 로그인 버튼 추가",
        "eliza 레포의 테스트 실패 고치기",
      ),
    ).toBeLessThan(THRESHOLD);
  });

  it("scores a Korean restatement of the same goal as a duplicate", () => {
    expect(
      goalSimilarity(
        "eliza 레포에 로그인 버튼 추가",
        "eliza 레포에 로그인 버튼 추가해줘",
      ),
    ).toBeGreaterThanOrEqual(THRESHOLD);
  });

  it("scores English goals as before", () => {
    expect(
      goalSimilarity(
        "add a login button to the eliza repo",
        "fix the failing tests in the eliza repo",
      ),
    ).toBe(0.5);
    expect(
      goalSimilarity(
        "Build the Nubs mechanical keyboard site",
        "Nubs mechanical keyboard site build",
      ),
    ).toBe(1);
  });
});
