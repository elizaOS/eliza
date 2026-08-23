/**
 * Unit coverage for API key prefix hints in api-key-prefix-hints.ts.
 *
 * Verifies key presence, prefix structures, case sensitivity, provider labels,
 * and key validation logic.
 */

import { describe, expect, it } from "vitest";
import { API_KEY_PREFIX_HINTS } from "./api-key-prefix-hints.js";

describe("api-key-prefix-hints", () => {
  it("defines prefix and label for all supported provider keys", () => {
    const requiredKeys = [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GROQ_API_KEY",
      "XAI_API_KEY",
      "OPENROUTER_API_KEY",
      "DEEPSEEK_API_KEY",
      "MOONSHOT_API_KEY",
    ];

    for (const key of requiredKeys) {
      const hint = API_KEY_PREFIX_HINTS[key];
      expect(hint).toBeDefined();
      expect(typeof hint.prefix).toBe("string");
      expect(hint.prefix.length).toBeGreaterThan(0);
      expect(typeof hint.label).toBe("string");
      expect(hint.label.length).toBeGreaterThan(0);
    }
  });

  it("validates expected provider prefixes accurately", () => {
    expect(API_KEY_PREFIX_HINTS.ANTHROPIC_API_KEY.prefix).toBe("sk-ant-");
    expect(API_KEY_PREFIX_HINTS.ANTHROPIC_API_KEY.label).toBe("Anthropic");

    expect(API_KEY_PREFIX_HINTS.OPENAI_API_KEY.prefix).toBe("sk-");
    expect(API_KEY_PREFIX_HINTS.OPENAI_API_KEY.label).toBe("OpenAI");

    expect(API_KEY_PREFIX_HINTS.GROQ_API_KEY.prefix).toBe("gsk_");
    expect(API_KEY_PREFIX_HINTS.GROQ_API_KEY.label).toBe("Groq");

    expect(API_KEY_PREFIX_HINTS.XAI_API_KEY.prefix).toBe("xai-");
    expect(API_KEY_PREFIX_HINTS.XAI_API_KEY.label).toBe("xAI");

    expect(API_KEY_PREFIX_HINTS.OPENROUTER_API_KEY.prefix).toBe("sk-or-");
    expect(API_KEY_PREFIX_HINTS.OPENROUTER_API_KEY.label).toBe("OpenRouter");

    expect(API_KEY_PREFIX_HINTS.DEEPSEEK_API_KEY.prefix).toBe("sk-");
    expect(API_KEY_PREFIX_HINTS.DEEPSEEK_API_KEY.label).toBe("DeepSeek");

    expect(API_KEY_PREFIX_HINTS.MOONSHOT_API_KEY.prefix).toBe("sk-");
    expect(API_KEY_PREFIX_HINTS.MOONSHOT_API_KEY.label).toBe("Kimi / Moonshot");
  });

  it("enforces case-sensitive prefix matching behavior", () => {
    function checkPrefix(key: string, value: string): boolean {
      const hint = API_KEY_PREFIX_HINTS[key];
      if (!hint) return true;
      return value.startsWith(hint.prefix);
    }

    expect(checkPrefix("ANTHROPIC_API_KEY", "sk-ant-live123")).toBe(true);
    expect(checkPrefix("ANTHROPIC_API_KEY", "SK-ANT-live123")).toBe(false);
    expect(checkPrefix("ANTHROPIC_API_KEY", "tencent/hy3-preview")).toBe(false);

    expect(checkPrefix("GROQ_API_KEY", "gsk_abc123")).toBe(true);
    expect(checkPrefix("GROQ_API_KEY", "GSK_abc123")).toBe(false);

    expect(checkPrefix("XAI_API_KEY", "xai-key456")).toBe(true);
    expect(checkPrefix("XAI_API_KEY", "XAI-key456")).toBe(false);

    expect(checkPrefix("OPENROUTER_API_KEY", "sk-or-v1-abc")).toBe(true);
    expect(checkPrefix("OPENROUTER_API_KEY", "sk-ant-wrong")).toBe(false);
  });
});
