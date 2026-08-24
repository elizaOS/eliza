/**
 * Verifies the config barrel that re-exports API-key prefix hints from
 * @elizaos/shared into @elizaos/ui/config: identical export surface, shared
 * object identity, and the record lookup semantics ApiKeyConfig relies on
 * when it derives per-field validation patterns.
 */

import { API_KEY_PREFIX_HINTS } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import type { ApiKeyPrefixHint } from "./api-key-prefix-hints";
import * as uiApiPrefixHints from "./api-key-prefix-hints";

function fieldPattern(hint: ApiKeyPrefixHint): RegExp {
  return new RegExp(`^${hint.prefix}`);
}

describe("ui config api-key-prefix-hints re-export", () => {
  it("exposes exactly one runtime export: the hints record", () => {
    expect(Object.keys(uiApiPrefixHints)).toEqual(["API_KEY_PREFIX_HINTS"]);
  });

  it("re-exports the identical object instance from @elizaos/shared", () => {
    expect(uiApiPrefixHints.API_KEY_PREFIX_HINTS).toBe(API_KEY_PREFIX_HINTS);
  });
});

describe("record shape behind the re-export", () => {
  it("keys every entry by its provider settings key", () => {
    const keys = Object.keys(API_KEY_PREFIX_HINTS);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key.endsWith("_API_KEY")).toBe(true);
    }
  });

  it("gives every entry exactly a non-empty prefix and label", () => {
    for (const hint of Object.values(API_KEY_PREFIX_HINTS)) {
      expect(Object.keys(hint).sort()).toEqual(["label", "prefix"]);
      expect(typeof hint.prefix).toBe("string");
      expect(hint.prefix.length).toBeGreaterThan(0);
      expect(typeof hint.label).toBe("string");
      expect(hint.label.length).toBeGreaterThan(0);
    }
  });
});

describe("lookup semantics consumed by ApiKeyConfig", () => {
  it("returns undefined for absent or differently-cased keys so field hints stay unset", () => {
    expect(API_KEY_PREFIX_HINTS.CUSTOM_MODEL_ENDPOINT).toBeUndefined();
    expect(API_KEY_PREFIX_HINTS.anthropic_api_key).toBeUndefined();
  });

  it("anchors patterns to the exact stored prefix, case-sensitively", () => {
    const openrouter = fieldPattern(API_KEY_PREFIX_HINTS.OPENROUTER_API_KEY);
    expect(openrouter.test("sk-or-v1-abc123")).toBe(true);
    expect(openrouter.test("tencent/hy3-preview")).toBe(false);

    const anthropic = fieldPattern(API_KEY_PREFIX_HINTS.ANTHROPIC_API_KEY);
    expect(anthropic.test("sk-ant-api03-live")).toBe(true);
    expect(anthropic.test("SK-ANT-api03-live")).toBe(false);
    expect(anthropic.test("sk-or-v1-abc123")).toBe(false);
  });

  it("keeps the OpenRouter prefix distinct from the generic sk- family it warns about", () => {
    expect(API_KEY_PREFIX_HINTS.OPENROUTER_API_KEY.prefix).not.toBe(
      API_KEY_PREFIX_HINTS.ANTHROPIC_API_KEY.prefix,
    );
    expect(API_KEY_PREFIX_HINTS.OPENROUTER_API_KEY.prefix).toBe("sk-or-");
    expect(
      fieldPattern(API_KEY_PREFIX_HINTS.OPENROUTER_API_KEY).test("sk-"),
    ).toBe(false);
  });
});
