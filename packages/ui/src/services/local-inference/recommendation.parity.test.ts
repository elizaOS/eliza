/** Proves the UI facade executes the shared recommendation policy unchanged. */

import type { HardwareProbe } from "@elizaos/shared";
import {
  MODEL_CATALOG,
  selectRecommendedModels as selectSharedRecommendedModels,
  UI_LOCAL_INFERENCE_RECOMMENDATION_POLICY,
} from "@elizaos/shared/local-inference";
import { describe, expect, it } from "vitest";
import {
  assessCatalogModelFit,
  selectRecommendedModels,
} from "./recommendation";

const probe = (overrides: Partial<HardwareProbe>): HardwareProbe => ({
  totalRamGb: 16,
  freeRamGb: 8,
  gpu: null,
  cpuCores: 8,
  platform: "linux",
  arch: "x64",
  appleSilicon: false,
  recommendedBucket: "mid",
  source: "os-fallback",
  ...overrides,
});

describe("local-inference recommendation parity", () => {
  it.each([
    probe({ totalRamGb: 8, mobile: { platform: "android" } }),
    probe({ totalRamGb: 8, mobile: { platform: "ios" } }),
    probe({ platform: "darwin", arch: "arm64", appleSilicon: true }),
    probe({
      totalRamGb: 32,
      gpu: { backend: "cuda", totalVramGb: 16, freeVramGb: 12 },
    }),
    probe({ platform: "win32", totalRamGb: 32 }),
  ])("matches the shared owner for %#", (hardware) => {
    expect(selectRecommendedModels(hardware)).toEqual(
      selectSharedRecommendedModels(hardware, MODEL_CATALOG, {
        policy: UI_LOCAL_INFERENCE_RECOMMENDATION_POLICY,
      }),
    );
  });

  it("preserves the UI's 4B quality floor for both mobile slots", () => {
    const result = selectRecommendedModels(
      probe({ totalRamGb: 8, mobile: { platform: "android" } }),
    );
    expect(result.TEXT_SMALL.model?.id).toBe("eliza-1-4b");
    expect(result.TEXT_LARGE.model?.id).toBe("eliza-1-4b");
  });

  it("keeps an iOS fallback probe with unknown NEON eligible for RAM-fit models", () => {
    const hardware = probe({
      totalRamGb: 8,
      platform: "darwin",
      arch: "arm64",
      appleSilicon: true,
      cpuFeatures: undefined,
      mobile: { platform: "ios" },
    });
    const model = MODEL_CATALOG.find(({ id }) => id === "eliza-1-4b");
    if (!model) throw new Error("4B catalog fixture is missing");
    expect(assessCatalogModelFit(hardware, model)).not.toBe("wontfit");
    expect(selectRecommendedModels(hardware).TEXT_SMALL.model?.id).toBe(
      "eliza-1-4b",
    );
    expect(
      selectRecommendedModels({
        ...hardware,
        cpuFeatures: { neon: false },
      }).TEXT_SMALL.model,
    ).toBeNull();
  });
});
