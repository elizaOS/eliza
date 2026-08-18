/**
 * Tests for API key prefix hints and prefix matching validation helpers.
 */
import { describe, expect, it } from "vitest";
import {
  API_KEY_PREFIX_HINTS,
  getApiKeyPrefixHint,
  matchesApiKeyPrefixHint,
} from "./api-key-prefix-hints.ts";

describe("API_KEY_PREFIX_HINTS", () => {
  it("contains expected prefix definitions for major AI providers", () => {
    expect(API_KEY_PREFIX_HINTS.ANTHROPIC_API_KEY).toEqual({
      prefix: "sk-ant-",
      label: "Anthropic",
    });
    expect(API_KEY_PREFIX_HINTS.OPENAI_API_KEY).toEqual({
      prefix: "sk-",
      label: "OpenAI",
    });
    expect(API_KEY_PREFIX_HINTS.GROQ_API_KEY).toEqual({
      prefix: "gsk_",
      label: "Groq",
    });
    expect(API_KEY_PREFIX_HINTS.XAI_API_KEY).toEqual({
      prefix: "xai-",
      label: "xAI",
    });
    expect(API_KEY_PREFIX_HINTS.OPENROUTER_API_KEY).toEqual({
      prefix: "sk-or-",
      label: "OpenRouter",
    });
  });
});

describe("getApiKeyPrefixHint", () => {
  it("retrieves prefix hint for known configuration keys", () => {
    expect(getApiKeyPrefixHint("ANTHROPIC_API_KEY")?.prefix).toBe("sk-ant-");
    expect(getApiKeyPrefixHint("  OPENROUTER_API_KEY  ")?.prefix).toBe(
      "sk-or-",
    );
  });

  it("returns undefined for unknown keys or nullish inputs", () => {
    expect(getApiKeyPrefixHint("UNKNOWN_KEY")).toBeUndefined();
    expect(getApiKeyPrefixHint(null)).toBeUndefined();
    expect(getApiKeyPrefixHint(undefined)).toBeUndefined();
    expect(getApiKeyPrefixHint(123 as unknown as string)).toBeUndefined();
  });
});

describe("matchesApiKeyPrefixHint", () => {
  it("returns true when value starts with expected prefix", () => {
    expect(
      matchesApiKeyPrefixHint(
        "ANTHROPIC_API_KEY",
        "sk-ant-api03-example-token",
      ),
    ).toBe(true);
    expect(
      matchesApiKeyPrefixHint("OPENAI_API_KEY", "sk-proj-example-token"),
    ).toBe(true);
    expect(matchesApiKeyPrefixHint("GROQ_API_KEY", "gsk_example_token")).toBe(
      true,
    );
    expect(
      matchesApiKeyPrefixHint("OPENROUTER_API_KEY", "  sk-or-v1-token  "),
    ).toBe(true);
  });

  it("returns false when value does not start with expected prefix", () => {
    expect(
      matchesApiKeyPrefixHint("OPENROUTER_API_KEY", "tencent/hy3-preview"),
    ).toBe(false);
    expect(matchesApiKeyPrefixHint("ANTHROPIC_API_KEY", "sk-invalid")).toBe(
      false,
    );
  });

  it("returns true for unhinted keys", () => {
    expect(matchesApiKeyPrefixHint("CUSTOM_API_KEY", "anything")).toBe(true);
    expect(matchesApiKeyPrefixHint(null, "anything")).toBe(true);
  });

  it("returns true for empty or whitespace values so empty-field validators handle them", () => {
    expect(matchesApiKeyPrefixHint("ANTHROPIC_API_KEY", "")).toBe(true);
    expect(matchesApiKeyPrefixHint("ANTHROPIC_API_KEY", "   ")).toBe(true);
  });

  it("returns false for non-string values on hinted keys", () => {
    expect(
      matchesApiKeyPrefixHint("ANTHROPIC_API_KEY", 123 as unknown as string),
    ).toBe(false);
    expect(
      matchesApiKeyPrefixHint("ANTHROPIC_API_KEY", null as unknown as string),
    ).toBe(false);
  });
});
