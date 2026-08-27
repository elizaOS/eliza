/**
 * Exercises the app's default character catalog module — the thin re-export of
 * `buildElizaCharacterCatalog()` from `@elizaos/shared` cast to
 * `CharacterCatalogData`. Verifies the public shape, deduplication, ordering,
 * and idempotency that consuming views and boot-config wiring depend on.
 */

import type {
  CharacterAssetEntry,
  InjectedCharacterEntry,
} from "@elizaos/ui/config";
import { describe, expect, it } from "vitest";

import { APP_CHARACTER_CATALOG } from "../src/character-catalog.js";

describe("APP_CHARACTER_CATALOG", () => {
  it("is a non-null object with assets and injectedCharacters arrays", () => {
    expect(APP_CHARACTER_CATALOG).toBeDefined();
    expect(typeof APP_CHARACTER_CATALOG).toBe("object");
    expect(Array.isArray(APP_CHARACTER_CATALOG.assets)).toBe(true);
    expect(Array.isArray(APP_CHARACTER_CATALOG.injectedCharacters)).toBe(true);
  });

  it("has at least one asset and one injected character", () => {
    expect(APP_CHARACTER_CATALOG.assets.length).toBeGreaterThanOrEqual(1);
    expect(
      APP_CHARACTER_CATALOG.injectedCharacters.length,
    ).toBeGreaterThanOrEqual(1);
  });

  describe("assets", () => {
    it("have numeric id, string slug, string title, and string sourceName", () => {
      for (const asset of APP_CHARACTER_CATALOG.assets) {
        expect(typeof asset.id).toBe("number");
        expect(typeof asset.slug).toBe("string");
        expect(typeof asset.title).toBe("string");
        expect(typeof asset.sourceName).toBe("string");
      }
    });

    it("carry unique ids", () => {
      const ids = APP_CHARACTER_CATALOG.assets.map(
        (a: CharacterAssetEntry) => a.id,
      );
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("carry unique slugs", () => {
      const slugs = APP_CHARACTER_CATALOG.assets.map(
        (a: CharacterAssetEntry) => a.slug,
      );
      expect(new Set(slugs).size).toBe(slugs.length);
    });

    it("are sorted ascending by id", () => {
      const ids = APP_CHARACTER_CATALOG.assets.map(
        (a: CharacterAssetEntry) => a.id,
      );
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i]).toBeGreaterThanOrEqual(ids[i - 1]);
      }
    });

    it("have slugs prefixed with eliza-", () => {
      for (const asset of APP_CHARACTER_CATALOG.assets) {
        expect(asset.slug).toMatch(/^eliza-/);
      }
    });
  });

  describe("injectedCharacters", () => {
    it("have string catchphrase, string name, and numeric avatarAssetId", () => {
      for (const character of APP_CHARACTER_CATALOG.injectedCharacters) {
        expect(typeof character.catchphrase).toBe("string");
        expect(typeof character.name).toBe("string");
        expect(typeof character.avatarAssetId).toBe("number");
      }
    });

    it("each avatarAssetId matches an asset id in the catalog", () => {
      const assetIds = new Set(
        APP_CHARACTER_CATALOG.assets.map((a: CharacterAssetEntry) => a.id),
      );
      for (const character of APP_CHARACTER_CATALOG.injectedCharacters) {
        expect(assetIds.has(character.avatarAssetId)).toBe(true);
      }
    });

    it("have unique names", () => {
      const names = APP_CHARACTER_CATALOG.injectedCharacters.map(
        (c: InjectedCharacterEntry) => c.name,
      );
      expect(new Set(names).size).toBe(names.length);
    });

    it("have non-empty catchphrases", () => {
      for (const character of APP_CHARACTER_CATALOG.injectedCharacters) {
        expect(character.catchphrase.length).toBeGreaterThan(0);
      }
    });
  });

  describe("cross-references", () => {
    it("has at least as many injected characters as assets (multi-persona avatars share one asset)", () => {
      expect(
        APP_CHARACTER_CATALOG.injectedCharacters.length,
      ).toBeGreaterThanOrEqual(APP_CHARACTER_CATALOG.assets.length);
    });

    it("each asset has sourceName equal to its title", () => {
      for (const asset of APP_CHARACTER_CATALOG.assets) {
        expect(asset.sourceName).toBe(asset.title);
      }
    });
  });

  describe("idempotency", () => {
    it("multiple accesses return a structurally identical catalog", () => {
      const { assets: a1, injectedCharacters: c1 } = APP_CHARACTER_CATALOG;
      const { assets: a2, injectedCharacters: c2 } = APP_CHARACTER_CATALOG;
      expect(a1).toEqual(a2);
      expect(c1).toEqual(c2);
    });
  });
});
