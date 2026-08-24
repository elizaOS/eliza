/**
 * Unit tests for catalog-policy predicates and default local model filter.
 * Validates Eliza-1 family prefix matching, default-eligibility set checks,
 * hidden catalog filtering, verified curated download detection, and exact model list outputs.
 */

import { describe, expect, it } from "vitest";
import {
  filterSettingsDefaultLocalModels,
  isDefaultLocalModelFamily,
  isEliza1ModelFamilyId,
  isSettingsDefaultLocalModel,
  isVerifiedCuratedEliza1Download,
} from "./catalog-policy.js";
import type { CatalogModel, InstalledModel } from "./types.js";

function createMockCatalogModel(
  id: string,
  overrides?: Partial<CatalogModel>,
): CatalogModel {
  return {
    id,
    displayName: `Model ${id}`,
    hfRepo: "elizaos/eliza-1",
    ggufFile: `${id}.gguf`,
    params: "2B",
    quant: "Q4_K_M",
    sizeGb: 1.5,
    minRamGb: 4,
    category: "chat",
    bucket: "small",
    blurb: `Curated model ${id}`,
    hiddenFromCatalog: false,
    ...overrides,
  };
}

function createMockInstalledModel(
  id: string,
  overrides?: Partial<InstalledModel>,
): InstalledModel {
  return {
    id,
    displayName: `Installed ${id}`,
    path: `/models/${id}.gguf`,
    sizeBytes: 1500000000,
    installedAt: "2026-08-24T00:00:00.000Z",
    lastUsedAt: null,
    source: "eliza-download",
    bundleVerifiedAt: "2026-08-24T01:00:00.000Z",
    ...overrides,
  };
}

describe("catalog-policy", () => {
  describe("isEliza1ModelFamilyId", () => {
    it("recognizes canonical eliza-1- prefixed model ids", () => {
      expect(isEliza1ModelFamilyId("eliza-1-2b")).toBe(true);
      expect(isEliza1ModelFamilyId("eliza-1-4b")).toBe(true);
      expect(isEliza1ModelFamilyId("eliza-1-9b")).toBe(true);
      expect(isEliza1ModelFamilyId("eliza-1-27b")).toBe(true);
      expect(isEliza1ModelFamilyId("eliza-1-custom")).toBe(true);
    });

    it("rejects non-Eliza-1 model ids and empty strings", () => {
      expect(isEliza1ModelFamilyId("llama-3-8b")).toBe(false);
      expect(isEliza1ModelFamilyId("gemma-2-2b")).toBe(false);
      expect(isEliza1ModelFamilyId("eliza-2-2b")).toBe(false);
      expect(isEliza1ModelFamilyId("")).toBe(false);
    });
  });

  describe("isDefaultLocalModelFamily", () => {
    it("returns true for curated Eliza-1 models present in DEFAULT_ELIGIBLE_MODEL_IDS", () => {
      const model2b = createMockCatalogModel("eliza-1-2b");
      const model9b = createMockCatalogModel("eliza-1-9b");
      expect(isDefaultLocalModelFamily(model2b)).toBe(true);
      expect(isDefaultLocalModelFamily(model9b)).toBe(true);
    });

    it("returns false for non-eligible Eliza-1 models or third-party models", () => {
      const customEliza = createMockCatalogModel("eliza-1-custom-experimental");
      const thirdParty = createMockCatalogModel("mistral-7b-instruct");
      expect(isDefaultLocalModelFamily(customEliza)).toBe(false);
      expect(isDefaultLocalModelFamily(thirdParty)).toBe(false);
    });
  });

  describe("isSettingsDefaultLocalModel", () => {
    it("returns true for eligible models when hiddenFromCatalog is false or omitted", () => {
      const visibleModel = createMockCatalogModel("eliza-1-2b", {
        hiddenFromCatalog: false,
      });
      expect(isSettingsDefaultLocalModel(visibleModel)).toBe(true);
    });

    it("returns false when model is flagged as hiddenFromCatalog", () => {
      const hiddenModel = createMockCatalogModel("eliza-1-2b", {
        hiddenFromCatalog: true,
      });
      expect(isSettingsDefaultLocalModel(hiddenModel)).toBe(false);
    });

    it("returns false for non-eligible models even if visible", () => {
      const nonEligible = createMockCatalogModel("llama-3-8b", {
        hiddenFromCatalog: false,
      });
      expect(isSettingsDefaultLocalModel(nonEligible)).toBe(false);
    });
  });

  describe("isVerifiedCuratedEliza1Download", () => {
    it("returns true for verified downloads of eligible Eliza-1 models", () => {
      const verified = createMockInstalledModel("eliza-1-2b", {
        source: "eliza-download",
        bundleVerifiedAt: "2026-08-24T01:00:00.000Z",
      });
      expect(isVerifiedCuratedEliza1Download(verified)).toBe(true);
    });

    it("returns false when source is not eliza-download", () => {
      const external = createMockInstalledModel("eliza-1-2b", {
        source: "external-scan",
        bundleVerifiedAt: "2026-08-24T01:00:00.000Z",
      });
      expect(isVerifiedCuratedEliza1Download(external)).toBe(false);
    });

    it("returns false when bundleVerifiedAt is missing, empty, or unverified", () => {
      const unverified = createMockInstalledModel("eliza-1-2b", {
        bundleVerifiedAt: undefined,
      });
      const emptyVerified = createMockInstalledModel("eliza-1-2b", {
        bundleVerifiedAt: "",
      });
      expect(isVerifiedCuratedEliza1Download(unverified)).toBe(false);
      expect(isVerifiedCuratedEliza1Download(emptyVerified)).toBe(false);
    });

    it("returns false when model id is not in DEFAULT_ELIGIBLE_MODEL_IDS", () => {
      const nonEligible = createMockInstalledModel("eliza-1-unknown-tier", {
        source: "eliza-download",
        bundleVerifiedAt: "2026-08-24T01:00:00.000Z",
      });
      expect(isVerifiedCuratedEliza1Download(nonEligible)).toBe(false);
    });
  });

  describe("filterSettingsDefaultLocalModels", () => {
    it("filters catalog to only eligible visible models with preserved ordering", () => {
      const catalog: CatalogModel[] = [
        createMockCatalogModel("eliza-1-2b", { hiddenFromCatalog: false }),
        createMockCatalogModel("eliza-1-4b", { hiddenFromCatalog: true }),
        createMockCatalogModel("llama-3-8b", { hiddenFromCatalog: false }),
        createMockCatalogModel("eliza-1-9b", { hiddenFromCatalog: false }),
        createMockCatalogModel("eliza-1-27b", { hiddenFromCatalog: false }),
      ];

      const filtered = filterSettingsDefaultLocalModels(catalog);
      expect(filtered.map((m) => m.id)).toEqual([
        "eliza-1-2b",
        "eliza-1-9b",
        "eliza-1-27b",
      ]);
    });

    it("returns empty array when no catalog models meet eligibility", () => {
      const catalog: CatalogModel[] = [
        createMockCatalogModel("llama-3-8b"),
        createMockCatalogModel("qwen-2.5-7b"),
      ];
      expect(filterSettingsDefaultLocalModels(catalog)).toEqual([]);
    });
  });
});
