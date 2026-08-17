/** Verifies the desktop packager always rebuilds both embedded server authorities. */

import { describe, expect, it } from "vitest";
import { canReuseDesktopRuntimePackage } from "./desktop-runtime-package-policy.mjs";

describe("desktop runtime package reuse", () => {
  it.each(["@elizaos/app-core", "@elizaos/agent"])(
    "rebuilds %s when unrelated newer dist bytes make it look fresh",
    (packageName) => {
      expect(
        canReuseDesktopRuntimePackage({
          packageName,
          forceRebuild: false,
          // Models a dist whose newest unrelated file is newer than src while a
          // newly-added source module has no emitted counterpart.
          looksBuilt: true,
        }),
      ).toBe(false);
    },
  );

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
