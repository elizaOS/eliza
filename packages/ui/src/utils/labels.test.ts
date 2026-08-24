/**
 * Unit tests for the label helpers re-exported from `@elizaos/shared`.
 * Fully deterministic: drives the real functions through this module's
 * re-export path, covering plugin-prefix stripping (both separator forms,
 * strict-remainder guard, single-strip break), underscore segmentation,
 * acronym preservation, and title-casing of remaining words.
 */
import { describe, expect, it } from "vitest";
import { autoLabel, ENV_KEY_ACRONYMS } from "./labels";

describe("autoLabel", () => {
  it("converts unmatched snake_case keys to spaced title case", () => {
    expect(autoLabel("my_plugin_key", "core")).toBe("My Plugin Key");
    expect(autoLabel("user_display_name", "core")).toBe("User Display Name");
  });

  it("strips the pluginId prefix when hyphens map to underscores", () => {
    // "my-plugin" normalizes to "MY_PLUGIN_", which the key must spell with
    // underscores to match.
    expect(autoLabel("MY_PLUGIN_API_KEY", "my-plugin")).toBe("API Key");
  });

  it("falls back to the concatenated prefix when the underscored one misses", () => {
    expect(autoLabel("MYPLUGIN_API_KEY", "my-plugin")).toBe("API Key");
  });

  it("matches the prefix case-insensitively and keeps the remainder's own case", () => {
    expect(autoLabel("core_value", "CORE")).toBe("Value");
    expect(autoLabel("MY_PLUGIN_URL", "My-Plugin")).toBe("URL");
  });

  it("strips at most one prefix occurrence", () => {
    // The loop breaks after the first successful strip, so the second
    // segment survives into the label.
    expect(autoLabel("CORE_CORE_VALUE", "core")).toBe("Core Value");
  });

  it("does not strip when the key is nothing but the prefix", () => {
    // Strict length guard: stripping requires a remainder longer than the
    // prefix, so "CORE_" and "CORE" survive as bare words.
    expect(autoLabel("CORE_", "core")).toBe("Core");
    expect(autoLabel("CORE", "core")).toBe("Core");
  });

  it("preserves known acronyms in the output", () => {
    expect(autoLabel("API_BASE_URL", "core")).toBe("API Base URL");
    expect(autoLabel("llm_api_key", "core")).toBe("LLM API Key");
    expect(autoLabel("rpc_endpoint", "core")).toBe("RPC Endpoint");
  });

  it("title-cases unknown words and flattens their inner casing", () => {
    // Only the first character keeps prominence; the rest of the word is
    // lowercased, so camelCase input collapses.
    expect(autoLabel("CORE_myValue", "core")).toBe("Myvalue");
    expect(autoLabel("v2_settings", "core")).toBe("V2 Settings");
  });

  it("drops empty segments from leading, trailing, and doubled underscores", () => {
    expect(autoLabel("_leading_trailing__", "core")).toBe("Leading Trailing");
    expect(autoLabel("a__b", "core")).toBe("A B");
  });

  it("renders an empty string for keys with no words", () => {
    expect(autoLabel("", "core")).toBe("");
    expect(autoLabel("__", "core")).toBe("");
  });

  it("treats an empty pluginId as a bare underscore prefix", () => {
    expect(autoLabel("_x", "")).toBe("X");
  });
});

describe("ENV_KEY_ACRONYMS", () => {
  it("exposes a runtime Set whose membership drives autoLabel casing", () => {
    expect(ENV_KEY_ACRONYMS).toBeInstanceOf(Set);
    expect(ENV_KEY_ACRONYMS.has("API")).toBe(true);
    expect(ENV_KEY_ACRONYMS.has("__NOT_AN_ACRONYM__")).toBe(false);
  });
});
