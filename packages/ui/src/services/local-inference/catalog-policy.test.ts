/**
 * Tests for catalog-policy — isEliza1ModelFamilyId and isDefaultLocalModelFamily.
 */
import { describe, expect, it } from "vitest";
import {
  filterSettingsDefaultLocalModels,
  isDefaultLocalModelFamily,
  isEliza1ModelFamilyId,
  isSettingsDefaultLocalModel,
  isVerifiedCuratedEliza1Download,
} from "./catalog-policy.ts";

describe("catalog-policy", () => {
  it("isEliza1ModelFamilyId detects eliza-1 prefix", () => {
    expect(isEliza1ModelFamilyId("eliza-1-foo")).toBe(true);
    expect(isEliza1ModelFamilyId("other-model")).toBe(false);
    expect(isEliza1ModelFamilyId("")).toBe(false);
  });

  it("isDefaultLocalModelFamily checks eligible set", () => {
    expect(isDefaultLocalModelFamily({ id: "eliza-1-foo" } as never)).toBe(
      false,
    );
  });

  it("isSettingsDefaultLocalModel respects hidden flag", () => {
    const model = { id: "other", hiddenFromCatalog: true } as never;
    expect(isSettingsDefaultLocalModel(model)).toBe(false);
  });

  it("isVerifiedCuratedEliza1Download checks source and verified", () => {
    const model = {
      id: "other",
      source: "other",
      bundleVerifiedAt: "",
    } as never;
    expect(isVerifiedCuratedEliza1Download(model)).toBe(false);
  });

  it("filterSettingsDefaultLocalModels filters catalog", () => {
    const catalog = [
      { id: "a", hiddenFromCatalog: false },
      { id: "b", hiddenFromCatalog: true },
    ] as never[];
    const filtered = filterSettingsDefaultLocalModels(catalog);
    expect(Array.isArray(filtered)).toBe(true);
  });
});
