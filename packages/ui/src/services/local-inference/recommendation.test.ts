/**
 * Unit tests for first-run model recommendation. Drives the real recommender
 * against synthetic catalog/hardware inputs to pin platform classification,
 * download sizing, per-class fit thresholds, slot ladder ordering (including
 * the long-context bump), kernel filtering, fallback candidate rules, and
 * first-run resolution order.
 */

import { describe, expect, it } from "vitest";
import { FIRST_RUN_DEFAULT_MODEL_ID, MODEL_CATALOG } from "./catalog.js";
import {
  assessCatalogModelFit,
  catalogDownloadSizeBytes,
  catalogDownloadSizeGb,
  chooseSmallerFallbackModel,
  classifyRecommendationPlatform,
  recommendForFirstRun,
  selectRecommendedModelForSlot,
  selectRecommendedModels,
} from "./recommendation.js";
import type { CatalogModel, HardwareProbe } from "./types.js";

function createCatalogModel(
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
    sizeGb: 1.4,
    minRamGb: 4,
    category: "chat",
    bucket: "small",
    blurb: `Curated model ${id}`,
    hiddenFromCatalog: false,
    contextLength: 131072,
    ...overrides,
  };
}

function createProbe(overrides?: Partial<HardwareProbe>): HardwareProbe {
  return {
    totalRamGb: 16,
    freeRamGb: 12,
    gpu: null,
    cpuCores: 8,
    platform: "darwin",
    arch: "arm64",
    appleSilicon: false,
    recommendedBucket: "mid",
    source: "os-fallback",
    ...overrides,
  };
}

/** Sizes/minRam mirror the real tiers so fit math is realistic. */
const tierCatalog: CatalogModel[] = [
  createCatalogModel("eliza-1-2b", { sizeGb: 1.4, minRamGb: 4 }),
  createCatalogModel("eliza-1-4b", { sizeGb: 2.6, minRamGb: 6 }),
  createCatalogModel("eliza-1-9b", { sizeGb: 5.4, minRamGb: 12 }),
  createCatalogModel("eliza-1-27b", {
    params: "27B",
    bucket: "large",
    sizeGb: 16.8,
    minRamGb: 32,
  }),
];

const appleSilicon32 = createProbe({
  totalRamGb: 32,
  freeRamGb: 24,
  appleSilicon: true,
});

describe("recommendation", () => {
  describe("classifyRecommendationPlatform", () => {
    it("classifies top-level android as mobile", () => {
      expect(
        classifyRecommendationPlatform(
          createProbe({ platform: "android", arch: "arm64" }),
        ),
      ).toBe("mobile");
    });

    it("prefers hardware.mobile.platform over the OS platform", () => {
      expect(
        classifyRecommendationPlatform(
          createProbe({
            appleSilicon: true,
            mobile: { platform: "ios" },
          }),
        ),
      ).toBe("mobile");
    });

    it("classifies apple silicon even with a GPU present", () => {
      expect(
        classifyRecommendationPlatform(
          createProbe({
            appleSilicon: true,
            gpu: { backend: "metal", totalVramGb: 16, freeVramGb: 8 },
          }),
        ),
      ).toBe("apple-silicon");
    });

    it("splits linux into gpu/cpu classes on GPU presence", () => {
      const linux = { platform: "linux" as const, arch: "x64" as const };
      expect(
        classifyRecommendationPlatform(
          createProbe({
            ...linux,
            gpu: { backend: "vulkan", totalVramGb: 8, freeVramGb: 4 },
          }),
        ),
      ).toBe("linux-gpu");
      expect(classifyRecommendationPlatform(createProbe(linux))).toBe(
        "linux-cpu",
      );
    });

    it("falls back to desktop classes for other platforms", () => {
      const win = { platform: "win32" as const, arch: "x64" as const };
      expect(
        classifyRecommendationPlatform(
          createProbe({
            ...win,
            gpu: { backend: "cuda", totalVramGb: 24, freeVramGb: 12 },
          }),
        ),
      ).toBe("desktop-gpu");
      expect(classifyRecommendationPlatform(createProbe(win))).toBe(
        "desktop-cpu",
      );
    });
  });

  describe("catalogDownloadSizeGb", () => {
    it("returns the model's own sizeGb regardless of the catalog passed", () => {
      const model = createCatalogModel("eliza-1-4b", { sizeGb: 3.7 });
      expect(catalogDownloadSizeGb(model)).toBe(3.7);
      expect(catalogDownloadSizeGb(model, [])).toBe(3.7);
      expect(catalogDownloadSizeGb(model, tierCatalog)).toBe(3.7);
    });
  });

  describe("catalogDownloadSizeBytes", () => {
    it("converts GiB sizes to rounded byte counts", () => {
      expect(
        catalogDownloadSizeBytes(createCatalogModel("m", { sizeGb: 2 })),
      ).toBe(2147483648);
      expect(
        catalogDownloadSizeBytes(createCatalogModel("m", { sizeGb: 1.4 })),
      ).toBe(1503238554);
    });
  });

  describe("assessCatalogModelFit", () => {
    it("applies mobile RAM-floor and 80%/65% size thresholds", () => {
      const phone = createProbe({ platform: "android", totalRamGb: 5 });
      expect(
        assessCatalogModelFit(phone, createCatalogModel("m", { minRamGb: 6 })),
      ).toBe("wontfit");
      expect(
        assessCatalogModelFit(
          phone,
          createCatalogModel("m", { sizeGb: 4.1, minRamGb: 4 }),
        ),
      ).toBe("wontfit");
      expect(
        assessCatalogModelFit(
          phone,
          createCatalogModel("m", { sizeGb: 3.4, minRamGb: 4 }),
        ),
      ).toBe("tight");
      expect(
        assessCatalogModelFit(
          phone,
          createCatalogModel("m", { sizeGb: 3.0, minRamGb: 4 }),
        ),
      ).toBe("fits");
    });

    it("uses half of system RAM as effective memory on CPU-only desktops", () => {
      const desktop = createProbe({
        platform: "linux",
        arch: "x64",
        totalRamGb: 20,
      });
      expect(
        assessCatalogModelFit(
          desktop,
          createCatalogModel("m", { minRamGb: 12 }),
        ),
      ).toBe("wontfit");
      expect(
        assessCatalogModelFit(
          desktop,
          createCatalogModel("m", { sizeGb: 9.7, minRamGb: 4 }),
        ),
      ).toBe("wontfit");
      expect(
        assessCatalogModelFit(
          desktop,
          createCatalogModel("m", { sizeGb: 8.5, minRamGb: 4 }),
        ),
      ).toBe("tight");
      expect(
        assessCatalogModelFit(
          desktop,
          createCatalogModel("m", { sizeGb: 6.9, minRamGb: 4 }),
        ),
      ).toBe("fits");
    });

    it("uses full RAM on Apple Silicon", () => {
      const mac = createProbe({ totalRamGb: 8, appleSilicon: true });
      expect(
        assessCatalogModelFit(mac, createCatalogModel("m", { minRamGb: 9 })),
      ).toBe("wontfit");
      expect(
        assessCatalogModelFit(
          mac,
          createCatalogModel("m", { sizeGb: 7.5, minRamGb: 4 }),
        ),
      ).toBe("wontfit");
    });

    it("prefers VRAM over half-RAM when a discrete GPU exists", () => {
      const rig = createProbe({
        platform: "win32",
        arch: "x64",
        totalRamGb: 32,
        gpu: { backend: "cuda", totalVramGb: 24, freeVramGb: 20 },
      });
      expect(
        assessCatalogModelFit(
          rig,
          createCatalogModel("m", { sizeGb: 22, minRamGb: 4 }),
        ),
      ).toBe("wontfit");
      expect(
        assessCatalogModelFit(
          rig,
          createCatalogModel("m", { sizeGb: 20, minRamGb: 4 }),
        ),
      ).toBe("tight");
      expect(
        assessCatalogModelFit(
          rig,
          createCatalogModel("m", { sizeGb: 16, minRamGb: 4 }),
        ),
      ).toBe("fits");
    });
  });

  describe("selectRecommendedModelForSlot", () => {
    it("walks the apple-silicon TEXT_LARGE ladder largest-first when everything fits", () => {
      const pick = selectRecommendedModelForSlot(
        "TEXT_LARGE",
        appleSilicon32,
        tierCatalog,
      );
      expect(pick.platformClass).toBe("apple-silicon");
      expect(pick.slot).toBe("TEXT_LARGE");
      expect(pick.model?.id).toBe("eliza-1-27b");
      expect(pick.fit).toBe("fits");
      expect(pick.alternatives.map((m) => m.id)).toEqual([
        "eliza-1-27b",
        "eliza-1-9b",
        "eliza-1-4b",
        "eliza-1-2b",
      ]);
      expect(pick.reason).toBe(
        "apple-silicon TEXT_LARGE ladder selected eliza-1-27b",
      );
    });

    it("keeps the smallest-fitting ladder entry for TEXT_SMALL", () => {
      const pick = selectRecommendedModelForSlot(
        "TEXT_SMALL",
        appleSilicon32,
        tierCatalog,
      );
      expect(pick.model?.id).toBe("eliza-1-2b");
      expect(pick.alternatives.map((m) => m.id)).toEqual([
        "eliza-1-2b",
        "eliza-1-4b",
      ]);
      expect(pick.reason).toBe(
        "apple-silicon TEXT_SMALL ladder selected eliza-1-2b",
      );
    });

    it("skips ladder entries that cannot fit and picks the first survivor", () => {
      const laptop = createProbe({ totalRamGb: 8, appleSilicon: true });
      const pick = selectRecommendedModelForSlot(
        "TEXT_LARGE",
        laptop,
        tierCatalog,
      );
      expect(pick.model?.id).toBe("eliza-1-4b");
      expect(pick.alternatives.map((m) => m.id)).toEqual([
        "eliza-1-4b",
        "eliza-1-2b",
      ]);
    });

    it("bumps long-context entries ahead of shorter ones on TEXT_LARGE when RAM allows", () => {
      const mixed: CatalogModel[] = [
        createCatalogModel("eliza-1-4b", {
          sizeGb: 2.6,
          minRamGb: 6,
          contextLength: 4096,
        }),
        createCatalogModel("eliza-1-2b", {
          sizeGb: 1.4,
          minRamGb: 4,
          contextLength: 131072,
        }),
      ];
      const pick = selectRecommendedModelForSlot(
        "TEXT_LARGE",
        createProbe({ totalRamGb: 16, freeRamGb: 12, appleSilicon: true }),
        mixed,
      );
      expect(pick.model?.id).toBe("eliza-1-2b");
      expect(pick.alternatives.map((m) => m.id)).toEqual([
        "eliza-1-2b",
        "eliza-1-4b",
      ]);
    });

    it("keeps ladder order below the 16 GB long-context threshold", () => {
      const mixed: CatalogModel[] = [
        createCatalogModel("eliza-1-4b", {
          sizeGb: 2.6,
          minRamGb: 6,
          contextLength: 4096,
        }),
        createCatalogModel("eliza-1-2b", {
          sizeGb: 1.4,
          minRamGb: 4,
          contextLength: 131072,
        }),
      ];
      const pick = selectRecommendedModelForSlot(
        "TEXT_LARGE",
        createProbe({ totalRamGb: 15, freeRamGb: 11, appleSilicon: true }),
        mixed,
      );
      expect(pick.model?.id).toBe("eliza-1-4b");
    });

    it("counts VRAM toward the long-context headroom threshold", () => {
      const mixed: CatalogModel[] = [
        createCatalogModel("eliza-1-4b", {
          sizeGb: 2.6,
          minRamGb: 6,
          contextLength: 4096,
        }),
        createCatalogModel("eliza-1-2b", {
          sizeGb: 1.4,
          minRamGb: 4,
          contextLength: 131072,
        }),
      ];
      const rig = createProbe({
        platform: "win32",
        arch: "x64",
        totalRamGb: 8,
        freeRamGb: 4,
        gpu: { backend: "cuda", totalVramGb: 24, freeVramGb: 20 },
      });
      const pick = selectRecommendedModelForSlot("TEXT_LARGE", rig, mixed);
      expect(pick.model?.id).toBe("eliza-1-2b");
    });

    it("never applies the long-context bump on TEXT_SMALL", () => {
      const mixed: CatalogModel[] = [
        createCatalogModel("eliza-1-2b", {
          sizeGb: 1.4,
          minRamGb: 4,
          contextLength: 4096,
        }),
        createCatalogModel("eliza-1-4b", {
          sizeGb: 2.6,
          minRamGb: 6,
          contextLength: 131072,
        }),
      ];
      const pick = selectRecommendedModelForSlot(
        "TEXT_SMALL",
        createProbe({ totalRamGb: 16, freeRamGb: 12, appleSilicon: true }),
        mixed,
      );
      expect(pick.model?.id).toBe("eliza-1-2b");
    });

    it("returns a null model when nothing fits anywhere", () => {
      const phone = createProbe({ platform: "android", totalRamGb: 2 });
      const pick = selectRecommendedModelForSlot(
        "TEXT_LARGE",
        phone,
        tierCatalog,
      );
      expect(pick.model).toBeNull();
      expect(pick.fit).toBeNull();
      expect(pick.alternatives).toEqual([]);
      expect(pick.platformClass).toBe("mobile");
      expect(pick.reason).toBe(
        "mobile TEXT_LARGE ladder has no fitting catalog model",
      );
    });

    it("degrades past the mobile 4B floor to a fitting 2B fallback", () => {
      const phone = createProbe({ platform: "android", totalRamGb: 5 });
      const pick = selectRecommendedModelForSlot(
        "TEXT_LARGE",
        phone,
        tierCatalog,
      );
      expect(pick.model?.id).toBe("eliza-1-2b");
      expect(pick.fit).toBe("fits");
      expect(pick.alternatives.map((m) => m.id)).toEqual(["eliza-1-2b"]);
    });

    it("orders fallback candidates largest-first for TEXT_LARGE", () => {
      const phone = createProbe({ platform: "android", totalRamGb: 5 });
      const catalog: CatalogModel[] = [
        createCatalogModel("eliza-1-2b", { sizeGb: 1.4, minRamGb: 4 }),
        createCatalogModel("eliza-1-9b", { sizeGb: 2.0, minRamGb: 4 }),
      ];
      const large = selectRecommendedModelForSlot("TEXT_LARGE", phone, catalog);
      expect(large.alternatives.map((m) => m.id)).toEqual([
        "eliza-1-9b",
        "eliza-1-2b",
      ]);
    });

    it("orders fallback candidates smallest-first for TEXT_SMALL", () => {
      const phone = createProbe({ platform: "android", totalRamGb: 5 });
      const catalog: CatalogModel[] = [
        createCatalogModel("eliza-1-2b", { sizeGb: 1.4, minRamGb: 4 }),
        createCatalogModel("eliza-1-9b", { sizeGb: 2.0, minRamGb: 4 }),
      ];
      const small = selectRecommendedModelForSlot("TEXT_SMALL", phone, catalog);
      expect(small.alternatives.map((m) => m.id)).toEqual([
        "eliza-1-2b",
        "eliza-1-9b",
      ]);
    });

    it("excludes hidden models from the fallback pool", () => {
      const phone = createProbe({ platform: "android", totalRamGb: 5 });
      const hiddenOnly: CatalogModel[] = [
        createCatalogModel("eliza-1-2b", { hiddenFromCatalog: true }),
      ];
      expect(
        selectRecommendedModelForSlot("TEXT_LARGE", phone, hiddenOnly).model,
      ).toBeNull();

      const visibleOnly: CatalogModel[] = [
        createCatalogModel("eliza-1-2b", { hiddenFromCatalog: false }),
      ];
      expect(
        selectRecommendedModelForSlot("TEXT_LARGE", phone, visibleOnly).model
          ?.id,
      ).toBe("eliza-1-2b");
    });

    it("excludes models outside the default-eligible set from the fallback pool", () => {
      const phone = createProbe({ platform: "android", totalRamGb: 5 });
      const thirdParty: CatalogModel[] = [
        createCatalogModel("acme-mini", { sizeGb: 0.5, minRamGb: 2 }),
      ];
      const pick = selectRecommendedModelForSlot(
        "TEXT_LARGE",
        phone,
        thirdParty,
      );
      expect(pick.model).toBeNull();
    });

    it("filters ladder entries whose required kernels are not advertised", () => {
      const catalog: CatalogModel[] = [
        createCatalogModel("eliza-1-2b", {
          runtime: { optimizations: { requiresKernel: ["qjl_full"] } },
        }),
        createCatalogModel("eliza-1-4b", {
          sizeGb: 2.6,
          minRamGb: 6,
          runtime: {
            optimizations: { requiresKernel: ["turbo3", "turbo4"] },
          },
        }),
      ];
      const kernels = { turbo3: true, turbo4: true };
      const pick = selectRecommendedModelForSlot(
        "TEXT_SMALL",
        appleSilicon32,
        catalog,
        { binaryKernels: kernels },
      );
      expect(pick.model?.id).toBe("eliza-1-4b");
      expect(pick.alternatives.map((m) => m.id)).toEqual(["eliza-1-4b"]);
    });

    it("trusts the catalog when no binary kernel probe exists", () => {
      const catalog: CatalogModel[] = [
        createCatalogModel("eliza-1-2b", {
          runtime: { optimizations: { requiresKernel: ["qjl_full"] } },
        }),
        createCatalogModel("eliza-1-4b", {
          sizeGb: 2.6,
          minRamGb: 6,
          runtime: {
            optimizations: { requiresKernel: ["turbo3", "turbo4"] },
          },
        }),
      ];
      const pick = selectRecommendedModelForSlot(
        "TEXT_SMALL",
        appleSilicon32,
        catalog,
      );
      expect(pick.model?.id).toBe("eliza-1-2b");
      expect(pick.alternatives.map((m) => m.id)).toEqual([
        "eliza-1-2b",
        "eliza-1-4b",
      ]);
    });

    it("drops unsupported-backend-only models when the binary advertises that backend", () => {
      const catalog: CatalogModel[] = [
        createCatalogModel("eliza-1-2b", {
          runtime: {
            optimizations: { unsupportedKernels: ["openvino"] },
          },
        }),
      ];
      const openvinoBinary = { openvino: true };
      expect(
        selectRecommendedModelForSlot("TEXT_SMALL", appleSilicon32, catalog, {
          binaryKernels: openvinoBinary,
        }).model,
      ).toBeNull();
      expect(
        selectRecommendedModelForSlot("TEXT_SMALL", appleSilicon32, catalog, {
          binaryKernels: {},
        }).model?.id,
      ).toBe("eliza-1-2b");
      expect(
        selectRecommendedModelForSlot("TEXT_SMALL", appleSilicon32, catalog)
          .model?.id,
      ).toBe("eliza-1-2b");
    });

    it("keeps a model whose required kernels are satisfied even when an unsupported backend is advertised", () => {
      const catalog: CatalogModel[] = [
        createCatalogModel("eliza-1-4b", {
          sizeGb: 2.6,
          minRamGb: 6,
          runtime: {
            optimizations: {
              requiresKernel: ["turbo3", "turbo4"],
              unsupportedKernels: ["openvino"],
            },
          },
        }),
      ];
      const pick = selectRecommendedModelForSlot(
        "TEXT_SMALL",
        appleSilicon32,
        catalog,
        {
          binaryKernels: { turbo3: true, turbo4: true, openvino: true },
        },
      );
      expect(pick.model?.id).toBe("eliza-1-4b");
    });
  });

  describe("selectRecommendedModels", () => {
    it("returns both slots with echoed slot labels on one classification", () => {
      const picks = selectRecommendedModels(appleSilicon32, tierCatalog);
      expect(Object.keys(picks).sort()).toEqual(["TEXT_LARGE", "TEXT_SMALL"]);
      expect(picks.TEXT_SMALL.slot).toBe("TEXT_SMALL");
      expect(picks.TEXT_LARGE.slot).toBe("TEXT_LARGE");
      expect(picks.TEXT_SMALL.platformClass).toBe("apple-silicon");
      expect(picks.TEXT_LARGE.platformClass).toBe("apple-silicon");
      expect(picks.TEXT_SMALL.model?.id).toBe("eliza-1-2b");
      expect(picks.TEXT_LARGE.model?.id).toBe("eliza-1-27b");
    });
  });

  describe("recommendForFirstRun", () => {
    it("resolves the shipped default tier from the real catalog", () => {
      const picked = recommendForFirstRun();
      expect(picked?.id).toBe(FIRST_RUN_DEFAULT_MODEL_ID);
      expect(picked).toBe(
        MODEL_CATALOG.find((m) => m.id === FIRST_RUN_DEFAULT_MODEL_ID),
      );
    });

    it("prefers the configured first-run id over later published entries", () => {
      const catalog: CatalogModel[] = [
        createCatalogModel("eliza-1-2b", { publishStatus: "published" }),
        createCatalogModel("eliza-1-4b", { publishStatus: "published" }),
      ];
      expect(recommendForFirstRun(catalog)?.id).toBe("eliza-1-2b");
    });

    it("falls back to the first published eligible entry when the preferred id is absent", () => {
      const catalog: CatalogModel[] = [
        createCatalogModel("eliza-1-4b", { publishStatus: "published" }),
        createCatalogModel("eliza-1-9b", { publishStatus: "published" }),
      ];
      expect(recommendForFirstRun(catalog)?.id).toBe("eliza-1-4b");
    });

    it("skips a pending preferred id in favor of the next published entry", () => {
      const catalog: CatalogModel[] = [
        createCatalogModel("eliza-1-2b", { publishStatus: "pending" }),
        createCatalogModel("eliza-1-4b"),
      ];
      expect(recommendForFirstRun(catalog)?.id).toBe("eliza-1-4b");
    });

    it("consults the shared tier publish-status map when the field is unset", () => {
      // eliza-1-9b is marked pending in the shared catalog hints, so the
      // earlier entry must lose to the later explicitly published one.
      const catalog: CatalogModel[] = [
        createCatalogModel("eliza-1-9b"),
        createCatalogModel("eliza-1-4b", { publishStatus: "published" }),
      ];
      expect(recommendForFirstRun(catalog)?.id).toBe("eliza-1-4b");
    });

    it("last-resorts to the preferred id when every eligible tier is pending", () => {
      const catalog: CatalogModel[] = [
        createCatalogModel("eliza-1-2b", { publishStatus: "pending" }),
        createCatalogModel("eliza-1-4b", { publishStatus: "pending" }),
      ];
      expect(recommendForFirstRun(catalog)?.id).toBe("eliza-1-2b");
    });

    it("last-resorts to any eligible tier when the preferred id is absent and everything is pending", () => {
      const catalog: CatalogModel[] = [
        createCatalogModel("eliza-1-4b", { publishStatus: "pending" }),
      ];
      expect(recommendForFirstRun(catalog)?.id).toBe("eliza-1-4b");
    });

    it("skips hidden eligible entries even when they are the preferred id", () => {
      const catalog: CatalogModel[] = [
        createCatalogModel("eliza-1-2b", { hiddenFromCatalog: true }),
        createCatalogModel("eliza-1-4b", { publishStatus: "published" }),
      ];
      expect(recommendForFirstRun(catalog)?.id).toBe("eliza-1-4b");
    });

    it("returns null when no default-eligible entry exists", () => {
      expect(recommendForFirstRun([])).toBeNull();
      expect(
        recommendForFirstRun([createCatalogModel("mistral-small")]),
      ).toBeNull();
    });
  });

  describe("chooseSmallerFallbackModel", () => {
    it("descends the TEXT_LARGE ladder to the largest strictly-smaller fitting tier", () => {
      const fallback = chooseSmallerFallbackModel(
        "eliza-1-9b",
        appleSilicon32,
        "TEXT_LARGE",
        MODEL_CATALOG,
      );
      expect(fallback?.id).toBe("eliza-1-4b");
    });

    it("treats an unknown current id as unbounded and offers the first fitting ladder entry", () => {
      const fallback = chooseSmallerFallbackModel(
        "not-installed",
        appleSilicon32,
        "TEXT_LARGE",
        MODEL_CATALOG,
      );
      expect(fallback?.id).toBe("eliza-1-27b");
    });

    it("skips equal-sized tiers because the comparison is strictly smaller", () => {
      const bigMac = createProbe({
        totalRamGb: 64,
        freeRamGb: 56,
        appleSilicon: true,
      });
      const fallback = chooseSmallerFallbackModel(
        "eliza-1-27b-256k",
        bigMac,
        "TEXT_LARGE",
        MODEL_CATALOG,
      );
      // eliza-1-27b is also 16.8 GB, so it is skipped for the 9B tier.
      expect(fallback?.id).toBe("eliza-1-9b");
    });

    it("skips ladder entries that cannot fit on the host", () => {
      const laptop = createProbe({ totalRamGb: 8, appleSilicon: true });
      const fallback = chooseSmallerFallbackModel(
        "eliza-1-27b",
        laptop,
        "TEXT_LARGE",
        MODEL_CATALOG,
      );
      expect(fallback?.id).toBe("eliza-1-4b");
    });

    it("falls back outside the ladder when the mobile slot has no smaller rung", () => {
      const phone = createProbe({ platform: "android", totalRamGb: 5 });
      const fallback = chooseSmallerFallbackModel(
        "eliza-1-4b",
        phone,
        "TEXT_LARGE",
        MODEL_CATALOG,
      );
      expect(fallback?.id).toBe("eliza-1-2b");
    });

    it("returns null when no smaller fitting candidate exists", () => {
      const phone = createProbe({ platform: "android", totalRamGb: 5 });
      const fallback = chooseSmallerFallbackModel(
        "eliza-1-2b",
        phone,
        "TEXT_LARGE",
        MODEL_CATALOG,
      );
      expect(fallback).toBeNull();
    });

    it("defaults to TEXT_LARGE and honours the slot argument", () => {
      const linuxCpu = createProbe({
        platform: "linux",
        arch: "x64",
        totalRamGb: 48,
        freeRamGb: 40,
      });
      expect(chooseSmallerFallbackModel("eliza-1-9b", linuxCpu)?.id).toBe(
        "eliza-1-4b",
      );
      expect(
        chooseSmallerFallbackModel("eliza-1-9b", linuxCpu, "TEXT_LARGE")?.id,
      ).toBe("eliza-1-4b");
      expect(
        chooseSmallerFallbackModel("eliza-1-9b", linuxCpu, "TEXT_SMALL")?.id,
      ).toBe("eliza-1-2b");
    });
  });
});
