/** Verifies the desktop packager never reuses a potentially partial app-core dist. */

import { describe, expect, it } from "vitest";
import { canReuseDesktopRuntimePackage } from "./desktop-runtime-package-policy.mjs";

describe("desktop runtime package reuse", () => {
  it("rebuilds app-core even when unrelated newer dist bytes make it look fresh", () => {
    expect(
      canReuseDesktopRuntimePackage({
        packageName: "@elizaos/app-core",
        forceRebuild: false,
        // Models a dist whose newest unrelated file is newer than src while a
        // newly-added source module has no emitted counterpart.
        looksBuilt: true,
      }),
    ).toBe(false);
  });

  it("retains reuse for heavier unchanged runtime dependencies", () => {
    expect(
      canReuseDesktopRuntimePackage({
        packageName: "@elizaos/core",
        forceRebuild: false,
        looksBuilt: true,
      }),
    ).toBe(true);
    expect(
      canReuseDesktopRuntimePackage({
        packageName: "@elizaos/core",
        forceRebuild: true,
        looksBuilt: true,
      }),
    ).toBe(false);
  });
});
