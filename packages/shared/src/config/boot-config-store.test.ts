/**
 * Unit tests for global boot config store and character catalog resolution.
 */

import { describe, expect, it } from "vitest";
import {
  type AppBootConfig,
  type CharacterCatalogData,
  DEFAULT_BOOT_CONFIG,
  getBootConfig,
  resolveCharacterCatalog,
  setBootConfig,
} from "./boot-config-store.js";

describe("boot-config-store", () => {
  it("manages boot config in global store", () => {
    const initial = getBootConfig();
    expect(initial.cloudApiBase).toBe(DEFAULT_BOOT_CONFIG.cloudApiBase);
    expect(initial.preferSharedCloudTier).toBe(true);

    const customConfig: AppBootConfig = {
      branding: { name: "Custom Eliza" },
      cloudApiBase: "https://custom.eliza.app",
      preferSharedCloudTier: false,
      autoUpgradeSharedToDedicated: true,
    };

    setBootConfig(customConfig);
    const updated = getBootConfig();
    expect(updated.branding?.name).toBe("Custom Eliza");
    expect(updated.cloudApiBase).toBe("https://custom.eliza.app");
    expect(updated.preferSharedCloudTier).toBe(false);
    expect(updated.autoUpgradeSharedToDedicated).toBe(true);
  });

  it("resolves character catalog assets and injected characters", () => {
    const catalogData: CharacterCatalogData = {
      assets: [
        {
          id: 1,
          slug: "eliza-default",
          title: "Eliza Default",
          sourceName: "eliza_default_vrm",
        },
        {
          id: 2,
          slug: "eliza-cyber",
          title: "Eliza Cyber",
          sourceName: "eliza_cyber_vrm",
        },
      ],
      injectedCharacters: [
        {
          name: "Cyber Eliza",
          catchphrase: "I am from the future",
          avatarAssetId: 2,
        },
      ],
    };

    const resolved = resolveCharacterCatalog(catalogData);

    expect(resolved.assetCount).toBe(2);
    expect(resolved.defaultAsset?.slug).toBe("eliza-default");
    expect(resolved.defaultAsset?.compressedVrmPath).toBe(
      "vrms/eliza-default.vrm.gz",
    );
    expect(resolved.defaultAsset?.rawVrmPath).toBe("vrms/eliza-default.vrm");
    expect(resolved.defaultAsset?.previewPath).toBe(
      "vrms/previews/eliza-default.png",
    );

    expect(resolved.injectedCharacterCount).toBe(1);
    const char = resolved.getInjectedCharacter("I am from the future");
    expect(char?.name).toBe("Cyber Eliza");
    expect(char?.avatarAsset.slug).toBe("eliza-cyber");

    expect(resolved.getAsset(2)?.slug).toBe("eliza-cyber");
    expect(resolved.getAsset(999)?.slug).toBe("eliza-default"); // falls back to default
  });
});
