/**
 * Unit coverage for the shared boot-config store (global-slot write-once
 * semantics and the window-mirror pre-boot seed) and the pure character-catalog
 * resolver. Deterministic, no network; the process-global slot is captured in
 * beforeEach and restored in afterEach so no state leaks between cases.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AppBootConfig,
  type CharacterCatalogData,
  DEFAULT_BOOT_CONFIG,
  getBootConfig,
  resolveCharacterCatalog,
  setBootConfig,
} from "./boot-config-store.ts";

// The symbol-string keys are the cross-bundle contract shared by the core,
// shared, and ui copies of this store, so tests address them directly.
const STORE_KEY = Symbol.for("elizaos.app.boot-config");
const WINDOW_KEY = "__ELIZAOS_APP_BOOT_CONFIG__";

const globals = globalThis as Record<PropertyKey, unknown>;

let priorStore: unknown;
let priorWindow: unknown;
let hadStore = false;
let hadWindow = false;

beforeEach(() => {
  hadStore = STORE_KEY in globals;
  hadWindow = WINDOW_KEY in globals;
  priorStore = globals[STORE_KEY];
  priorWindow = globals[WINDOW_KEY];
  delete globals[STORE_KEY];
  delete globals[WINDOW_KEY];
});

afterEach(() => {
  if (hadStore) {
    globals[STORE_KEY] = priorStore;
  } else {
    delete globals[STORE_KEY];
  }
  if (hadWindow) {
    globals[WINDOW_KEY] = priorWindow;
  } else {
    delete globals[WINDOW_KEY];
  }
});

function bootConfig(overrides: Partial<AppBootConfig> = {}): AppBootConfig {
  return { ...structuredClone(DEFAULT_BOOT_CONFIG), ...overrides };
}

function catalog(
  overrides: Partial<CharacterCatalogData> = {},
): CharacterCatalogData {
  return {
    assets: [
      { id: 1, slug: "nova", title: "Nova", sourceName: "nova_v2" },
      { id: 2, slug: "orion", title: "Orion", sourceName: "orion_v1" },
    ],
    injectedCharacters: [
      {
        catchphrase: "gm",
        name: "Morning Bot",
        avatarAssetId: 2,
        voicePresetId: "warm",
      },
    ],
    ...overrides,
  };
}

describe("getBootConfig", () => {
  it("seeds defaults when neither a store nor a window mirror exists", () => {
    expect(getBootConfig()).toEqual(DEFAULT_BOOT_CONFIG);
    // Seeding publishes the store and mirrors its current value into the
    // window key so a later bootstrap bundle reads the same object.
    expect(globals[WINDOW_KEY]).toBe(getBootConfig());
  });

  it("seeds from a pre-boot window mirror before creating the store", () => {
    const mirrored = bootConfig({ apiBase: "https://mirror.example" });
    globals[WINDOW_KEY] = mirrored;
    expect(getBootConfig()).toBe(mirrored);
  });

  it("lets an established store win over a stale window mirror", () => {
    const established = bootConfig({ cloudApiBase: "https://store.example" });
    const stale = bootConfig({ cloudApiBase: "https://stale.example" });
    globals[STORE_KEY] = { current: established };
    globals[WINDOW_KEY] = stale;
    expect(getBootConfig()).toBe(established);
    // The write-once rule means the mirror is never rewritten by readers.
    expect(globals[WINDOW_KEY]).toBe(stale);
  });

  it("treats a malformed store slot as absent and re-seeds", () => {
    const mirrored = bootConfig({ assetBaseUrl: "/assets/" });
    globals[STORE_KEY] = 42;
    globals[WINDOW_KEY] = mirrored;
    expect(getBootConfig()).toBe(mirrored);
  });
});

describe("setBootConfig", () => {
  it("replaces the current config and refreshes the window mirror", () => {
    const first = bootConfig({ apiBase: "https://first.example" });
    setBootConfig(first);
    expect(getBootConfig()).toBe(first);
    expect(globals[WINDOW_KEY]).toBe(first);

    const second = bootConfig({ apiBase: "https://second.example" });
    setBootConfig(second);
    expect(getBootConfig()).toBe(second);
    expect(globals[WINDOW_KEY]).toBe(second);
  });
});

describe("resolveCharacterCatalog", () => {
  it("derives canonical VRM asset paths from slug and source name", () => {
    const resolved = resolveCharacterCatalog(catalog());
    expect(resolved.assets[0]).toEqual({
      id: 1,
      slug: "nova",
      title: "Nova",
      sourceName: "nova_v2",
      compressedVrmPath: "vrms/nova.vrm.gz",
      rawVrmPath: "vrms/nova.vrm",
      previewPath: "vrms/previews/nova.png",
      backgroundPath: "vrms/backgrounds/nova.png",
      sourceVrmFilename: "nova_v2.vrm",
    });
  });

  it("counts assets and picks the first as the default", () => {
    const resolved = resolveCharacterCatalog(catalog());
    expect(resolved.assetCount).toBe(2);
    expect(resolved.defaultAsset?.slug).toBe("nova");
    // Unknown ids fall back to the default asset.
    expect(resolved.getAsset(999)?.slug).toBe("nova");
  });

  it("resolves an empty catalog to zero assets and a null default", () => {
    const resolved = resolveCharacterCatalog({
      assets: [],
      injectedCharacters: [],
    });
    expect(resolved.assetCount).toBe(0);
    expect(resolved.defaultAsset).toBeNull();
    expect(resolved.injectedCharacterCount).toBe(0);
    expect(resolved.getAsset(1)).toBeNull();
  });

  it("links each injected character to its avatar asset by id", () => {
    const resolved = resolveCharacterCatalog(catalog());
    expect(resolved.injectedCharacterCount).toBe(1);
    const character = resolved.getInjectedCharacter("gm");
    expect(character?.name).toBe("Morning Bot");
    expect(character?.avatarAsset.slug).toBe("orion");
    expect(character?.voicePresetId).toBe("warm");
  });

  it("falls back to the default asset when an injected id is unknown", () => {
    const resolved = resolveCharacterCatalog(
      catalog({
        injectedCharacters: [
          { catchphrase: "hi", name: "Lost Bot", avatarAssetId: 99 },
        ],
      }),
    );
    expect(resolved.injectedCharacters[0]?.avatarAsset.slug).toBe("nova");
  });

  it("throws when an injected character has no asset and no default exists", () => {
    expect(() =>
      resolveCharacterCatalog(
        catalog({
          assets: [],
          injectedCharacters: [
            { catchphrase: "hi", name: "Ghost", avatarAssetId: 99 },
          ],
        }),
      ),
    ).toThrowError(/Missing avatar asset 99 for Ghost\./);
  });

  it("resolves lookups by catchphrase, with the last duplicate winning", () => {
    const resolved = resolveCharacterCatalog(
      catalog({
        injectedCharacters: [
          { catchphrase: "gm", name: "First", avatarAssetId: 1 },
          { catchphrase: "gm", name: "Second", avatarAssetId: 2 },
          { catchphrase: "gn", name: "Night", avatarAssetId: 1 },
        ],
      }),
    );
    expect(resolved.getInjectedCharacter("gm")?.name).toBe("Second");
    expect(resolved.getInjectedCharacter("gn")?.name).toBe("Night");
    expect(resolved.getInjectedCharacter("unknown")).toBeNull();
  });
});
