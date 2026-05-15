import { describe, expect, it } from "vitest";
import { shouldEnable } from "../auto-enable";

function ctx(env: Record<string, string | undefined>) {
  return { env, config: {}, isNativePlatform: false };
}

describe("plugin-anthropic-proxy auto-enable", () => {
  it("enables when CLAUDE_MAX_PROXY_MODE=inline", () => {
    expect(shouldEnable(ctx({ CLAUDE_MAX_PROXY_MODE: "inline" }))).toBe(true);
  });

  it("enables when CLAUDE_MAX_PROXY_MODE=shared", () => {
    expect(shouldEnable(ctx({ CLAUDE_MAX_PROXY_MODE: "shared" }))).toBe(true);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(shouldEnable(ctx({ CLAUDE_MAX_PROXY_MODE: "  INLINE  " }))).toBe(true);
    expect(shouldEnable(ctx({ CLAUDE_MAX_PROXY_MODE: "Shared" }))).toBe(true);
  });

  it("does NOT enable when CLAUDE_MAX_PROXY_MODE=off", () => {
    expect(shouldEnable(ctx({ CLAUDE_MAX_PROXY_MODE: "off" }))).toBe(false);
  });

  it("does NOT enable when CLAUDE_MAX_PROXY_MODE is missing", () => {
    expect(shouldEnable(ctx({}))).toBe(false);
  });

  it("does NOT enable when CLAUDE_MAX_PROXY_MODE is empty string", () => {
    expect(shouldEnable(ctx({ CLAUDE_MAX_PROXY_MODE: "" }))).toBe(false);
    expect(shouldEnable(ctx({ CLAUDE_MAX_PROXY_MODE: "   " }))).toBe(false);
  });

  it("does NOT enable on unknown values (strict allow-list)", () => {
    expect(shouldEnable(ctx({ CLAUDE_MAX_PROXY_MODE: "yes" }))).toBe(false);
    expect(shouldEnable(ctx({ CLAUDE_MAX_PROXY_MODE: "true" }))).toBe(false);
    expect(shouldEnable(ctx({ CLAUDE_MAX_PROXY_MODE: "on" }))).toBe(false);
  });

  it("ignores ANTHROPIC_BASE_URL (the plugin SETS that, doesn't read it)", () => {
    expect(
      shouldEnable(ctx({ ANTHROPIC_BASE_URL: "http://127.0.0.1:18801/v1" })),
    ).toBe(false);
  });

  it("ignores CLAUDE_MAX_CREDENTIALS_PATH alone", () => {
    expect(
      shouldEnable(ctx({ CLAUDE_MAX_CREDENTIALS_PATH: "/some/path.json" })),
    ).toBe(false);
  });
});
