/**
 * Tests for brand environment alias mapping and prefix normalization.
 */
import { describe, expect, it } from "vitest";
import {
  BRAND_ENV_ALIAS_DEFINITIONS,
  buildBrandEnvAliases,
  buildBrandEnvSyncAliases,
  normalizeBrandEnvPrefix,
} from "./brand-env-aliases.ts";

describe("normalizeBrandEnvPrefix", () => {
  it("defaults to ELIZA when prefix is undefined", () => {
    expect(normalizeBrandEnvPrefix(undefined)).toBe("ELIZA");
  });

  it("normalizes lowercase and mixed-case identifiers to uppercase", () => {
    expect(normalizeBrandEnvPrefix("custom")).toBe("CUSTOM");
    expect(normalizeBrandEnvPrefix("AgentApp")).toBe("AGENTAPP");
  });

  it("replaces dashes, dots, and symbols with underscores and trims edge underscores", () => {
    expect(normalizeBrandEnvPrefix("my-custom.app")).toBe("MY_CUSTOM_APP");
    expect(normalizeBrandEnvPrefix("  ___my-cool_app___  ")).toBe(
      "MY_COOL_APP",
    );
  });

  it("throws for empty, whitespace-only, or purely symbolic prefixes", () => {
    expect(() => normalizeBrandEnvPrefix("")).toThrow(/non-empty identifier/);
    expect(() => normalizeBrandEnvPrefix("   ")).toThrow(
      /non-empty identifier/,
    );
    expect(() => normalizeBrandEnvPrefix("---___...")).toThrow(
      /non-empty identifier/,
    );
  });
});

describe("buildBrandEnvAliases", () => {
  it("generates alias pairs for standard and Vite environment variables", () => {
    const aliases = buildBrandEnvAliases("CUSTOM");
    expect(Array.isArray(aliases)).toBe(true);
    expect(aliases.length).toBe(BRAND_ENV_ALIAS_DEFINITIONS.length);

    expect(aliases).toContainEqual(["CUSTOM_STATE_DIR", "ELIZA_STATE_DIR"]);
    expect(aliases).toContainEqual(["CUSTOM_API_TOKEN", "ELIZA_API_TOKEN"]);
    expect(aliases).toContainEqual([
      "VITE_CUSTOM_SETTINGS_DEBUG",
      "VITE_ELIZA_SETTINGS_DEBUG",
    ]);
  });
});

describe("buildBrandEnvSyncAliases", () => {
  it("uses syncElizaKey overrides where defined", () => {
    const syncAliases = buildBrandEnvSyncAliases("CUSTOM");
    expect(Array.isArray(syncAliases)).toBe(true);
    expect(syncAliases.length).toBe(BRAND_ENV_ALIAS_DEFINITIONS.length);

    // PORT uses syncElizaKey: "ELIZA_UI_PORT"
    expect(syncAliases).toContainEqual(["CUSTOM_PORT", "ELIZA_UI_PORT"]);

    // Standard entries remain identical
    expect(syncAliases).toContainEqual(["CUSTOM_STATE_DIR", "ELIZA_STATE_DIR"]);
  });
});

describe("BRAND_ENV_ALIAS_DEFINITIONS", () => {
  it("exports definitions array with valid suffix and elizaKey shapes", () => {
    expect(Array.isArray(BRAND_ENV_ALIAS_DEFINITIONS)).toBe(true);
    expect(BRAND_ENV_ALIAS_DEFINITIONS.length).toBeGreaterThan(20);
    for (const def of BRAND_ENV_ALIAS_DEFINITIONS) {
      expect(typeof def.brandSuffix).toBe("string");
      expect(typeof def.elizaKey).toBe("string");
      expect(def.brandSuffix.length).toBeGreaterThan(0);
      expect(
        def.elizaKey.startsWith("ELIZA_") ||
          def.elizaKey.startsWith("VITE_ELIZA_"),
      ).toBe(true);
    }
  });
});
