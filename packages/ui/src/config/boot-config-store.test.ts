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
});

// ---------------------------------------------------------------------------
// Store behavior — added with #16919 to satisfy the enforced changed-file
// coverage gate honestly (the flag flip is the fix; these pin the store
// semantics the fix depends on).
// ---------------------------------------------------------------------------

import {
  getBootConfig,
  resolveCharacterCatalog,
  setBootConfig,
} from "./boot-config-store";

const STORE_KEY = Symbol.for("elizaos.app.boot-config");
const WINDOW_KEY = "__ELIZAOS_APP_BOOT_CONFIG__";

type GlobalSlot = Record<PropertyKey, unknown>;

function resetGlobalStore(): void {
  const slot = globalThis as GlobalSlot;
  delete slot[STORE_KEY];
  delete slot[WINDOW_KEY];
}

describe("boot config store", () => {
  it("getBootConfig serves DEFAULT_BOOT_CONFIG before any setBootConfig call", () => {
    resetGlobalStore();
    expect(getBootConfig()).toEqual(DEFAULT_BOOT_CONFIG);
    resetGlobalStore();
  });

  it("setBootConfig replaces the live config and mirrors it to the window key", () => {
    resetGlobalStore();
    const next = {
      ...DEFAULT_BOOT_CONFIG,
      cloudApiBase: "https://staging.example",
      preferSharedCloudTier: false,
    };
    setBootConfig(next);
    expect(getBootConfig()).toBe(next);
    expect((globalThis as GlobalSlot)[WINDOW_KEY]).toBe(next);
    resetGlobalStore();
  });

  it("seeds from a pre-boot window mirror exactly once and then ignores it", () => {
    resetGlobalStore();
    const mirrored = {
      ...DEFAULT_BOOT_CONFIG,
      cloudApiBase: "https://mirrored.example",
    };
    (globalThis as GlobalSlot)[WINDOW_KEY] = mirrored;
    expect(getBootConfig()).toBe(mirrored);
    // An established store wins over later mirror writes (write-once seed).
    (globalThis as GlobalSlot)[WINDOW_KEY] = {
      ...DEFAULT_BOOT_CONFIG,
      cloudApiBase: "https://late-mirror.example",
    };
    expect(getBootConfig()).toBe(mirrored);
    resetGlobalStore();
  });
});

describe("resolveCharacterCatalog", () => {
  const catalog = {
    assets: [
      { id: 1, slug: "aria", title: "Aria", sourceName: "aria-src" },
      { id: 2, slug: "kai", title: "Kai", sourceName: "kai-src" },
    ],
    injectedCharacters: [
      { catchphrase: "hello!", name: "Aria", avatarAssetId: 1 },
      { catchphrase: "yo", name: "Ghost", avatarAssetId: 999 },
    ],
  };

  it("resolves asset paths, counts, and default asset", () => {
    const resolved = resolveCharacterCatalog(catalog);
    expect(resolved.assetCount).toBe(2);
    expect(resolved.defaultAsset?.slug).toBe("aria");
    expect(resolved.assets[0]).toMatchObject({
      compressedVrmPath: "vrms/aria.vrm.gz",
      rawVrmPath: "vrms/aria.vrm",
      previewPath: "vrms/previews/aria.png",
      backgroundPath: "vrms/backgrounds/aria.png",
      sourceVrmFilename: "aria-src.vrm",
    });
  });

  it("getAsset returns the match by id and falls back to the default asset", () => {
    const resolved = resolveCharacterCatalog(catalog);
    expect(resolved.getAsset(2)?.slug).toBe("kai");
    expect(resolved.getAsset(404)?.slug).toBe("aria");
  });

  it("injected characters bind their avatar asset, falling back to default when missing", () => {
    const resolved = resolveCharacterCatalog(catalog);
    expect(resolved.injectedCharacterCount).toBe(2);
    expect(resolved.getInjectedCharacter("hello!")?.avatarAsset.slug).toBe(
      "aria",
    );
    // avatarAssetId 999 does not exist -> falls back to the default asset.
    expect(resolved.getInjectedCharacter("yo")?.avatarAsset.slug).toBe("aria");
    expect(resolved.getInjectedCharacter("nope")).toBeNull();
  });

  it("throws when an avatar asset is missing and there is no default fallback", () => {
    expect(() =>
      resolveCharacterCatalog({
        assets: [],
        injectedCharacters: [
          { catchphrase: "hi", name: "Nobody", avatarAssetId: 1 },
        ],
      }),
    ).toThrow(/Missing avatar asset 1 for Nobody/);
  });
});
