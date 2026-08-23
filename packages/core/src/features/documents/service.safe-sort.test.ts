/**
 * Regression for documents service similarity and createdAt sort — imports production comparators.
 */
import { describe, expect, it } from "vitest";
import {
  __testCompareDocumentByCreatedAt,
  __testCompareDocumentBySimilarity,
} from "./comparators.ts";

describe("documents service safe-sort", () => {
  it("treats NaN/Infinity similarity as 0 (sorted after finite)", () => {
    const docs = [
      { id: "b", similarity: Number.NaN },
      { id: "a", similarity: 0.9 },
      { id: "c", similarity: Number.POSITIVE_INFINITY },
    ];
    expect([...docs].sort(__testCompareDocumentBySimilarity).map((d) => d.id)).toEqual(["a", "b", "c"]);
  });
  it("treats NaN createdAt as 0", () => {
    const docs = [
      { id: "b", createdAt: Number.NaN },
      { id: "a", createdAt: 100 },
      { id: "c", createdAt: Number.POSITIVE_INFINITY },
    ];
    expect([...docs].sort(__testCompareDocumentByCreatedAt).map((d) => d.id)).toEqual(["a", "b", "c"]);
  });
  it("breaks ties by id", () => {
    const docs = [
      { id: "b", similarity: 0.5 },
      { id: "a", similarity: 0.5 },
    ];
    expect([...docs].sort(__testCompareDocumentBySimilarity).map((d) => d.id)).toEqual(["a", "b"]);
  });
});
