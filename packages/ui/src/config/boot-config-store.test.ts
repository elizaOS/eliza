/**
 * Unit coverage for the default boot config invariants. Pure data, no runtime.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_BOOT_CONFIG } from "./boot-config-store";

describe("DEFAULT_BOOT_CONFIG", () => {
  it("defaults preferSharedCloudTier ON so a fresh signup chats instantly from the shared runtime while the dedicated container boots (#15518 decision; regression of the 90s+ provisioning wall)", () => {
    expect(DEFAULT_BOOT_CONFIG.preferSharedCloudTier).toBe(true);
  });

  it("agrees with the packages/shared copy of the default (two boot-config stores must not disagree on the signup path)", async () => {
    // Read the shared store source instead of importing it: that module
    // re-exports from @elizaos/core, whose generated i18n data is not built in
    // this package's test env. Textual assertion on the default literal keeps
    // the two stores honest without dragging in the core build.
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const sharedStorePath = fileURLToPath(
      new URL(
        "../../../shared/src/config/boot-config-store.ts",
        import.meta.url,
      ),
    );
    const source = await readFile(sharedStorePath, "utf8");
    const literal = DEFAULT_BOOT_CONFIG.preferSharedCloudTier
      ? "preferSharedCloudTier: true"
      : "preferSharedCloudTier: false";
    expect(source).toContain(literal);
  });

  it("keeps preferSharedCloudTier overridable as the dedicated-direct kill-switch", () => {
    const dedicatedDirect = {
      ...DEFAULT_BOOT_CONFIG,
      preferSharedCloudTier: false,
    };

    expect(dedicatedDirect.preferSharedCloudTier).toBe(false);
  });
});
