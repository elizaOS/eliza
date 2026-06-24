import { describe, expect, it } from "vitest";

import { androidUsesAppDirFor } from "./lib/mobile-build-decisions.mjs";

// Issue #9309 §5: verify brand/whitelabel separation holds — an eliza-root build
// targets the shared canonical elizaOS Android tree, while a whitelabel build
// (or an explicit override) is forced into its own appDir tree so the two brands
// never corrupt each other's native project.
describe("androidUsesAppDirFor (brand separation)", () => {
  it("eliza root build uses the shared canonical tree (targets eliza)", () => {
    expect(androidUsesAppDirFor("ai.elizaos.app", {})).toBe(false);
  });

  it("a whitelabel app is forced into its own appDir tree", () => {
    expect(androidUsesAppDirFor("com.acme.whitelabel", {})).toBe(true);
  });

  it("ELIZA_ANDROID_USE_APP_DIR=1 forces the app dir even for eliza", () => {
    expect(
      androidUsesAppDirFor("ai.elizaos.app", {
        ELIZA_ANDROID_USE_APP_DIR: "1",
      }),
    ).toBe(true);
  });

  it("a non-'1' override value does not flip eliza off the shared tree", () => {
    expect(
      androidUsesAppDirFor("ai.elizaos.app", {
        ELIZA_ANDROID_USE_APP_DIR: "0",
      }),
    ).toBe(false);
  });
});
