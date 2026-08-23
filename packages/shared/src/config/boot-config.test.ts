/**
 * Unit coverage for the store-only boot-config entry in boot-config.ts.
 *
 * Verifies that the entry forwards the real boot-config-store runtime
 * bindings by identity and that those forwarded bindings drive the
 * process-global boot config singleton, its window mirror seed semantics,
 * character catalog resolution, and env alias resolution end to end.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppBootConfig } from "./boot-config.js";
import * as bootConfigEntry from "./boot-config.js";
import {
  DEFAULT_BOOT_CONFIG,
  getBootConfig,
  resolveCharacterCatalog,
  setBootConfig,
} from "./boot-config-store.js";

const BOOT_CONFIG_STORE_KEY = Symbol.for("elizaos.app.boot-config");
const BOOT_CONFIG_WINDOW_KEY = "__ELIZAOS_APP_BOOT_CONFIG__";

const globalSlot = () => globalThis as Record<string | symbol, unknown>;

describe("boot-config store-only entry", () => {
  let savedStore: unknown;
  let savedMirror: unknown;

  beforeEach(() => {
    const slot = globalSlot();
    savedStore = slot[BOOT_CONFIG_STORE_KEY];
    savedMirror = slot[BOOT_CONFIG_WINDOW_KEY];
    delete slot[BOOT_CONFIG_STORE_KEY];
    delete slot[BOOT_CONFIG_WINDOW_KEY];
  });

  afterEach(() => {
    const slot = globalSlot();
    delete slot[BOOT_CONFIG_STORE_KEY];
    delete slot[BOOT_CONFIG_WINDOW_KEY];
    if (savedStore !== undefined) {
      slot[BOOT_CONFIG_STORE_KEY] = savedStore;
    }
    if (savedMirror !== undefined) {
      slot[BOOT_CONFIG_WINDOW_KEY] = savedMirror;
    }
  });

  describe("re-export wiring", () => {
    it("forwards every runtime binding of boot-config-store by identity", () => {
      expect(bootConfigEntry.getBootConfig).toBe(getBootConfig);
      expect(bootConfigEntry.setBootConfig).toBe(setBootConfig);
      expect(bootConfigEntry.resolveCharacterCatalog).toBe(
        resolveCharacterCatalog,
      );
      expect(bootConfigEntry.DEFAULT_BOOT_CONFIG).toBe(DEFAULT_BOOT_CONFIG);
      expect(typeof bootConfigEntry.resolveAliasedEnvValue).toBe("function");
    });
  });

  describe("getBootConfig", () => {
    it("seeds a pristine process from DEFAULT_BOOT_CONFIG", () => {
      const config = getBootConfig();

      expect(config).toBe(DEFAULT_BOOT_CONFIG);
      expect(config.branding).toEqual({});
      expect(config.cloudApiBase).toBe("https://api.eliza.app");
      expect(config.preferSharedCloudTier).toBe(true);
      expect(config.autoUpgradeSharedToDedicated).toBe(false);

      const slot = globalSlot();
      expect(slot[BOOT_CONFIG_WINDOW_KEY]).toBe(DEFAULT_BOOT_CONFIG);
      const seededStore = slot[BOOT_CONFIG_STORE_KEY] as
        | { current?: AppBootConfig }
        | undefined;
      expect(seededStore?.current).toBe(DEFAULT_BOOT_CONFIG);
    });

    it("adopts a pre-boot window mirror once when no store exists yet", () => {
      const seed: AppBootConfig = {
        branding: {},
        apiBase: "https://mirror.example.test",
      };
      globalSlot()[BOOT_CONFIG_WINDOW_KEY] = seed;

      expect(getBootConfig()).toBe(seed);

      // The mirror is consumed into the established store; later calls keep
      // returning the adopted value even though the store now exists.
      globalSlot()[BOOT_CONFIG_WINDOW_KEY] = DEFAULT_BOOT_CONFIG;
      expect(getBootConfig()).toBe(seed);
    });

    it("keeps an established store even when the window mirror changes", () => {
      const established: AppBootConfig = {
        branding: {},
        apiBase: "https://established.example.test",
      };
      setBootConfig(established);

      const decoy: AppBootConfig = { branding: {}, apiBase: "https://decoy" };
      globalSlot()[BOOT_CONFIG_WINDOW_KEY] = decoy;

      expect(getBootConfig()).toBe(established);
      expect(getBootConfig()).not.toBe(decoy);
    });
  });

  describe("setBootConfig", () => {
    it("replaces the current config and mirrors it on globalThis", () => {
      const next: AppBootConfig = {
        branding: { appName: "MirrorTest" },
        apiBase: "https://api.example.test",
        defaultApps: ["chat"],
      };

      setBootConfig(next);

      expect(getBootConfig()).toBe(next);
      expect(globalSlot()[BOOT_CONFIG_WINDOW_KEY]).toBe(next);
    });
  });

  describe("resolveCharacterCatalog", () => {
    it("resolves derived asset paths and indexes injected characters", () => {
      const resolved = resolveCharacterCatalog({
        assets: [
          { id: 1, slug: "alpha", title: "Alpha", sourceName: "AlphaSrc" },
          { id: 2, slug: "beta", title: "Beta", sourceName: "BetaSrc" },
        ],
        injectedCharacters: [
          {
            catchphrase: "hello there",
            name: "Greeter",
            avatarAssetId: 2,
          },
          {
            catchphrase: "fallback friend",
            name: "Fallbacker",
            avatarAssetId: 999,
          },
        ],
      });

      expect(resolved.assetCount).toBe(2);
      expect(resolved.defaultAsset).toBe(resolved.assets[0]);

      expect(resolved.assets[0]).toEqual({
        id: 1,
        slug: "alpha",
        title: "Alpha",
        sourceName: "AlphaSrc",
        compressedVrmPath: "vrms/alpha.vrm.gz",
        rawVrmPath: "vrms/alpha.vrm",
        previewPath: "vrms/previews/alpha.png",
        backgroundPath: "vrms/backgrounds/alpha.png",
        sourceVrmFilename: "AlphaSrc.vrm",
      });

      expect(resolved.injectedCharacters[0].avatarAsset.slug).toBe("beta");
      // Unknown avatarAssetId falls back to the default asset (assets[0]).
      expect(resolved.injectedCharacters[1].avatarAsset.slug).toBe("alpha");
      expect(resolved.injectedCharacterCount).toBe(2);

      expect(resolved.getAsset(2)?.slug).toBe("beta");
      expect(resolved.getAsset(1234)?.slug).toBe("alpha");

      expect(resolved.getInjectedCharacter("hello there")?.name).toBe(
        "Greeter",
      );
      expect(resolved.getInjectedCharacter("missing catchphrase")).toBeNull();
    });

    it("returns an empty resolution for a catalog without assets or characters", () => {
      const resolved = resolveCharacterCatalog({
        assets: [],
        injectedCharacters: [],
      });

      expect(resolved.assets).toEqual([]);
      expect(resolved.assetCount).toBe(0);
      expect(resolved.defaultAsset).toBeNull();
      expect(resolved.injectedCharacters).toEqual([]);
      expect(resolved.injectedCharacterCount).toBe(0);
      expect(resolved.getAsset(1)).toBeNull();
      expect(resolved.getInjectedCharacter("any")).toBeNull();
    });

    it("throws for an injected character when the catalog has no assets at all", () => {
      expect(() =>
        resolveCharacterCatalog({
          assets: [],
          injectedCharacters: [
            { catchphrase: "hi", name: "Orphan", avatarAssetId: 7 },
          ],
        }),
      ).toThrowError(/Missing avatar asset 7 for Orphan\./);
    });
  });

  describe("resolveAliasedEnvValue forwarding", () => {
    it("prefers a direct env value over its alias partner", () => {
      const aliases: readonly (readonly [string, string])[] = [
        ["ELIZA_TEST_PRIMARY", "ELIZA_TEST_PARTNER"],
      ];
      const env = {
        ELIZA_TEST_PRIMARY: "direct",
        ELIZA_TEST_PARTNER: "partner",
      };

      expect(
        bootConfigEntry.resolveAliasedEnvValue(
          "ELIZA_TEST_PRIMARY",
          aliases,
          env,
        ),
      ).toBe("direct");
    });

    it("resolves through the alias partner when the direct key is absent", () => {
      const aliases: readonly (readonly [string, string])[] = [
        ["ELIZA_TEST_PRIMARY", "ELIZA_TEST_PARTNER"],
      ];

      expect(
        bootConfigEntry.resolveAliasedEnvValue("ELIZA_TEST_PRIMARY", aliases, {
          ELIZA_TEST_PARTNER: "partner",
        }),
      ).toBe("partner");
    });

    it("returns undefined when neither the direct key nor partners carry values", () => {
      expect(
        bootConfigEntry.resolveAliasedEnvValue("ELIZA_TEST_ABSENT", [], {}),
      ).toBeUndefined();
      expect(
        bootConfigEntry.resolveAliasedEnvValue("ELIZA_TEST_ABSENT", [], null),
      ).toBeUndefined();
    });
  });
});
