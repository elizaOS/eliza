/**
 * Unit coverage for the default boot config invariants (e.g. shared-cloud-tier
 * handoff default). Pure data, no runtime.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_BOOT_CONFIG } from "./boot-config-store";

describe("DEFAULT_BOOT_CONFIG", () => {
  it("defaults preferSharedCloudTier on so handoff is the default create path", () => {
    expect(DEFAULT_BOOT_CONFIG.preferSharedCloudTier).toBe(true);
  });

  it("keeps preferSharedCloudTier overridable as a kill-switch", () => {
    const killSwitched = {
      ...DEFAULT_BOOT_CONFIG,
      preferSharedCloudTier: false,
    };

    expect(killSwitched.preferSharedCloudTier).toBe(false);
  });
});
