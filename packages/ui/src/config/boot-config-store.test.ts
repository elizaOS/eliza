/**
 * Unit coverage for the default boot config invariants. Pure data, no runtime.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_BOOT_CONFIG } from "./boot-config-store";

describe("DEFAULT_BOOT_CONFIG", () => {
  it("defaults preferSharedCloudTier off so cloud first-run binds dedicated directly", () => {
    expect(DEFAULT_BOOT_CONFIG.preferSharedCloudTier).toBe(false);
  });

  it("keeps preferSharedCloudTier overridable for explicit shared-tier experiments", () => {
    const sharedTierEnabled = {
      ...DEFAULT_BOOT_CONFIG,
      preferSharedCloudTier: true,
    };

    expect(sharedTierEnabled.preferSharedCloudTier).toBe(true);
  });
});
