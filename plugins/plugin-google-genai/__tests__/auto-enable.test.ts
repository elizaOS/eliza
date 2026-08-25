import { describe, expect, it } from "vitest";
import { shouldEnable } from "../auto-enable";

type Ctx = Parameters<typeof shouldEnable>[0];

function ctxWithEnv(env: Record<string, string | undefined>): Ctx {
  return { env, config: {} } as Ctx;
}

describe("plugin-google-genai auto-enable gate", () => {
  it("enables when a concrete Gemini API key is set", () => {
    expect(shouldEnable(ctxWithEnv({ GEMINI_API_KEY: "AIza-real-key" }))).toBe(
      true,
    );
  });

  it("enables when a concrete GOOGLE_API_KEY is set", () => {
    expect(shouldEnable(ctxWithEnv({ GOOGLE_API_KEY: "AIza-real-key" }))).toBe(
      true,
    );
  });

  it("enables when a concrete GOOGLE_GENERATIVE_AI_API_KEY is set", () => {
    expect(
      shouldEnable(
        ctxWithEnv({ GOOGLE_GENERATIVE_AI_API_KEY: "AIza-real-key" }),
      ),
    ).toBe(true);
  });

  it("stays disabled when no key is set", () => {
    expect(shouldEnable(ctxWithEnv({}))).toBe(false);
  });

  it("stays disabled for blank or whitespace-only keys", () => {
    expect(shouldEnable(ctxWithEnv({ GEMINI_API_KEY: "" }))).toBe(false);
    expect(shouldEnable(ctxWithEnv({ GEMINI_API_KEY: "   " }))).toBe(false);
  });

  it("rejects placeholder keys that previously spoofed the gate", () => {
    for (const placeholder of [
      "REDACTED",
      "[REDACTED]",
      "PLACEHOLDER",
      "TODO",
      "CHANGEME",
      "EMPTY",
      "changeme",
    ]) {
      expect(
        shouldEnable(ctxWithEnv({ GEMINI_API_KEY: placeholder })),
        `GEMINI_API_KEY=${placeholder}`,
      ).toBe(false);
      expect(
        shouldEnable(ctxWithEnv({ GOOGLE_API_KEY: placeholder })),
        `GOOGLE_API_KEY=${placeholder}`,
      ).toBe(false);
    }
  });

  it("enables when any of the three keys is concrete", () => {
    expect(
      shouldEnable(
        ctxWithEnv({
          GOOGLE_API_KEY: "REDACTED",
          GEMINI_API_KEY: "AIza-real-key",
        }),
      ),
    ).toBe(true);
  });
});
