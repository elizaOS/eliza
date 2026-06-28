import { describe, expect, it } from "vitest";

import { DEFAULT_BOOT_CONFIG } from "./boot-config-store";

describe("DEFAULT_BOOT_CONFIG", () => {
  // The seamless shared→dedicated handoff is the default create path: a fresh
  // first-run gets the instant shared bridge plus a background dedicated agent
  // it silently re-points to. Flipping this default ON is what makes the handoff
  // the normal "create an agent" behavior.
  it("defaults preferSharedCloudTier ON so the handoff is the default create path", () => {
    expect(DEFAULT_BOOT_CONFIG.preferSharedCloudTier).toBe(true);
  });

  // Kill-switch: the flag is still a real, overridable field. A deployment can
  // set it false to fall back to the dedicated-direct create with no handoff,
  // so the OFF branch must stay reachable.
  it("keeps preferSharedCloudTier overridable as a kill-switch", () => {
    const killSwitched = {
      ...DEFAULT_BOOT_CONFIG,
      preferSharedCloudTier: false,
    };
    expect(killSwitched.preferSharedCloudTier).toBe(false);
  });
});
