/**
 * Unit coverage for environment alias definition and normalization in
 * brand-env-aliases.ts.
 *
 * Verifies normalizeBrandEnvPrefix identifier sanitization, buildBrandEnvAliases
 * standard and Vite prefix mappings, and buildBrandEnvSyncAliases overrides.
 */

import { describe, expect, it } from "vitest";
import {
  BRAND_ENV_ALIAS_DEFINITIONS,
  buildBrandEnvAliases,
  buildBrandEnvSyncAliases,
  normalizeBrandEnvPrefix,
} from "./brand-env-aliases.js";

describe("brand-env-aliases", () => {
  describe("normalizeBrandEnvPrefix", () => {
    it("normalizes and uppercases clean prefix", () => {
      expect(normalizeBrandEnvPrefix("acme")).toBe("ACME");
      expect(normalizeBrandEnvPrefix("MY_BRAND")).toBe("MY_BRAND");
    });

    it("replaces special characters with underscores and trims edge underscores", () => {
      expect(normalizeBrandEnvPrefix("  my-brand.corp!  ")).toBe(
        "MY_BRAND_CORP",
      );
      expect(normalizeBrandEnvPrefix("__custom__")).toBe("CUSTOM");
    });

    it("defaults to ELIZA when prefix is undefined", () => {
      expect(normalizeBrandEnvPrefix(undefined)).toBe("ELIZA");
    });

    it("throws when prefix resolves to empty string", () => {
      expect(() => normalizeBrandEnvPrefix("")).toThrow(
        "Brand env prefix must resolve to a non-empty identifier",
      );
      expect(() => normalizeBrandEnvPrefix("   !!!   ")).toThrow(
        "Brand env prefix must resolve to a non-empty identifier",
      );
    });
  });

  describe("buildBrandEnvAliases", () => {
    it("generates brand-to-eliza alias pairs for given prefix", () => {
      const aliases = buildBrandEnvAliases("ACME");
      expect(aliases.length).toBe(BRAND_ENV_ALIAS_DEFINITIONS.length);

      const stateDirPair = aliases.find(
        ([, eliza]) => eliza === "ELIZA_STATE_DIR",
      );
      expect(stateDirPair).toEqual(["ACME_STATE_DIR", "ELIZA_STATE_DIR"]);

      const apiTokenPair = aliases.find(
        ([, eliza]) => eliza === "ELIZA_API_TOKEN",
      );
      expect(apiTokenPair).toEqual(["ACME_API_TOKEN", "ELIZA_API_TOKEN"]);
    });

    it("prefixes vite-flagged definitions with VITE_", () => {
      const aliases = buildBrandEnvAliases("ACME");
      const viteDebugPair = aliases.find(
        ([brand]) => brand === "VITE_ACME_SETTINGS_DEBUG",
      );
      expect(viteDebugPair).toEqual([
        "VITE_ACME_SETTINGS_DEBUG",
        "VITE_ELIZA_SETTINGS_DEBUG",
      ]);
    });
  });

  describe("buildBrandEnvSyncAliases", () => {
    it("uses syncElizaKey when available in definition", () => {
      const syncAliases = buildBrandEnvSyncAliases("ACME");
      const portPair = syncAliases.find(([brand]) => brand === "ACME_PORT");
      expect(portPair).toEqual(["ACME_PORT", "ELIZA_UI_PORT"]);
    });

    it("falls back to standard elizaKey when syncElizaKey is not specified", () => {
      const syncAliases = buildBrandEnvSyncAliases("ACME");
      const apiPortPair = syncAliases.find(
        ([brand]) => brand === "ACME_API_PORT",
      );
      expect(apiPortPair).toEqual(["ACME_API_PORT", "ELIZA_API_PORT"]);
    });
  });
});
