/** Exercises brand identifier normalization and compatibility environment mappings. */
import { describe, expect, it } from "vitest";
import {
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

  it("maps standard, Vite and port-sync aliases for a custom brand", () => {
    expect(buildBrandEnvAliases("ACME")).toEqual(
      expect.arrayContaining([
        ["ACME_STATE_DIR", "ELIZA_STATE_DIR"],
        ["ACME_API_TOKEN", "ELIZA_API_TOKEN"],
        ["VITE_ACME_SETTINGS_DEBUG", "VITE_ELIZA_SETTINGS_DEBUG"],
      ]),
    );
    expect(buildBrandEnvSyncAliases("ACME")).toEqual(
      expect.arrayContaining([
        ["ACME_PORT", "ELIZA_UI_PORT"],
        ["ACME_API_PORT", "ELIZA_API_PORT"],
      ]),
    );
  });
});
