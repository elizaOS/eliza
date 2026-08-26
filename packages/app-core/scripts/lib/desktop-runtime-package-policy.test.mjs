/** Verifies the desktop packager always rebuilds both server authorities. */

import { describe, expect, it } from "vitest";
import { canReuseDesktopRuntimePackage } from "./desktop-runtime-package-policy.mjs";

describe("desktop runtime package reuse", () => {
  it.each(["@elizaos/app-core", "@elizaos/agent"])(
    "rebuilds %s even when its dist looks fresh",
    (packageName) => {
      expect(
        canReuseDesktopRuntimePackage({
          packageName,
          forceRebuild: false,
          looksBuilt: true,
        }),
      ).toBe(false);
    },
  );

  it("retains reuse for heavier unchanged runtime dependencies", () => {
    expect(
      canReuseDesktopRuntimePackage({
        packageName: "@elizaos/ui",
        forceRebuild: false,
        looksBuilt: true,
      }),
    ).toBe(true);
  });

  it("honors the explicit full-runtime rebuild switch", () => {
    expect(
      canReuseDesktopRuntimePackage({
        packageName: "@elizaos/ui",
        forceRebuild: true,
        looksBuilt: true,
      }),
    ).toBe(false);
  });
});
