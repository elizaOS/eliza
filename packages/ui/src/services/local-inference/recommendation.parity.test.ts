/** Proves the UI facade executes the shared recommendation policy unchanged. */

import type { HardwareProbe } from "@elizaos/shared";
import { selectRecommendedModels as selectSharedRecommendedModels } from "@elizaos/shared/local-inference";
import { describe, expect, it } from "vitest";
import { selectRecommendedModels } from "./recommendation";

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
      selectSharedRecommendedModels(hardware),
    );
  });

  it("uses the explicit mobile 2B-small and 4B-large policy", () => {
    const result = selectRecommendedModels(
      probe({ totalRamGb: 8, mobile: { platform: "android" } }),
    );
    expect(result.TEXT_SMALL.model?.id).toBe("eliza-1-2b");
    expect(result.TEXT_LARGE.model?.id).toBe("eliza-1-4b");
  });
});
