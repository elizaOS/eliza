import { describe, expect, it } from "vitest";
import { shouldEnable } from "./auto-enable";

type Ctx = {
  config: unknown;
  env: Record<string, unknown>;
};

const ctx = (env: Record<string, unknown>): Ctx =>
  ({ config: {}, env }) as Ctx;

describe("plugin-cli-inference auto-enable env gate", () => {
  it.each(["claude", "CLAUDE", " claude ", "Claude", "claude-sdk", "codex", "codex-sdk", " Codex "])(
    "enables for whitelisted backend %j",
    (value) => {
      expect(shouldEnable(ctx({ ELIZA_CHAT_VIA_CLI: value }))).toBe(true);
    },
  );

  it.each(["", "   ", "claude-cli", "codex-cli", "opencode", "gpt", "claude3", "codex-claude", "anthropic", "claude code"])(
    "stays fail-closed for non-whitelisted value %j",
    (value) => {
      expect(shouldEnable(ctx({ ELIZA_CHAT_VIA_CLI: value }))).toBe(false);
    },
  );

  it("stays fail-closed when the env var is unset", () => {
    expect(shouldEnable(ctx({}))).toBe(false);
  });

  it("stays fail-closed for non-string env values", () => {
    expect(shouldEnable(ctx({ ELIZA_CHAT_VIA_CLI: 42 }))).toBe(false);
    expect(shouldEnable(ctx({ ELIZA_CHAT_VIA_CLI: null }))).toBe(false);
  });

  it("never enables when a different env var is set", () => {
    expect(
      shouldEnable(
        ctx({ ELIZA_CHAT_VIA_CLI: undefined, OTHER_SETTING: "claude" }),
      ),
    ).toBe(false);
  });
});
