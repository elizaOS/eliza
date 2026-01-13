import { describe, expect, test } from "vitest";
import { resolveModelProvider } from "../lib/model-provider.js";

describe("resolveModelProvider", () => {
  test("prefers explicit provider setting", () => {
    const provider = resolveModelProvider({
      ELIZA_CODE_PROVIDER: "openai",
      ANTHROPIC_API_KEY: "anthropic-key",
      OPENAI_API_KEY: "openai-key",
    });
    expect(provider).toBe("openai");
  });

  test("auto-detects anthropic when ANTHROPIC_API_KEY is set", () => {
    const provider = resolveModelProvider({
      ANTHROPIC_API_KEY: "anthropic-key",
    });
    expect(provider).toBe("anthropic");
  });

  test("auto-detects openai when OPENAI_API_KEY is set", () => {
    const provider = resolveModelProvider({
      OPENAI_API_KEY: "openai-key",
    });
    expect(provider).toBe("openai");
  });

  test("auto-detects openai when both keys are set", () => {
    const provider = resolveModelProvider({
      ANTHROPIC_API_KEY: "anthropic-key",
      OPENAI_API_KEY: "openai-key",
    });
    expect(provider).toBe("openai");
  });

  test("throws when no provider is configured", () => {
    expect(() => resolveModelProvider({})).toThrow();
  });
});
