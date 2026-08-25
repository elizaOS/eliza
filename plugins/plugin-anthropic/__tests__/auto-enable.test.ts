import { describe, expect, it } from "vitest";
import { shouldEnable } from "../auto-enable";

type Ctx = Parameters<typeof shouldEnable>[0];

function ctxWithEnv(env: Record<string, string | undefined>): Ctx {
  return { env, config: {} } as Ctx;
}

describe("plugin-anthropic auto-enable gate", () => {
  it("enables when a concrete ANTHROPIC_API_KEY is set", () => {
    expect(shouldEnable(ctxWithEnv({ ANTHROPIC_API_KEY: "sk-ant-real-key" }))).toBe(true);
  });

  it("enables when a concrete CLAUDE_API_KEY is set", () => {
    expect(shouldEnable(ctxWithEnv({ CLAUDE_API_KEY: "sk-ant-real-key" }))).toBe(true);
  });

  it("stays disabled when no key is set", () => {
    expect(shouldEnable(ctxWithEnv({}))).toBe(false);
  });

  it("stays disabled for blank or whitespace-only keys", () => {
    expect(shouldEnable(ctxWithEnv({ ANTHROPIC_API_KEY: "" }))).toBe(false);
    expect(shouldEnable(ctxWithEnv({ ANTHROPIC_API_KEY: "   " }))).toBe(false);
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
        shouldEnable(ctxWithEnv({ ANTHROPIC_API_KEY: placeholder })),
        `ANTHROPIC_API_KEY=${placeholder}`
      ).toBe(false);
      expect(
        shouldEnable(ctxWithEnv({ CLAUDE_API_KEY: placeholder })),
        `CLAUDE_API_KEY=${placeholder}`
      ).toBe(false);
    }
  });

  it("enables when one key is a placeholder and the other is concrete", () => {
    expect(
      shouldEnable(
        ctxWithEnv({
          ANTHROPIC_API_KEY: "REDACTED",
          CLAUDE_API_KEY: "sk-ant-real-key",
        })
      )
    ).toBe(true);
  });
});
