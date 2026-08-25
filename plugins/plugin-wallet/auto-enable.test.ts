import { describe, expect, it } from "vitest";
import { shouldEnable } from "./wallet-auto-enable";

function ctx(
  env: Record<string, string | undefined>,
  config: Record<string, unknown> = {},
): {
  env: Record<string, string | undefined>;
  config: Record<string, unknown>;
  isNativePlatform: boolean;
} {
  return { env, config, isNativePlatform: false };
}

describe("plugin-wallet auto-enable", () => {
  it("enables when EVM_PRIVATE_KEY is a concrete value", () => {
    expect(shouldEnable(ctx({ EVM_PRIVATE_KEY: "0xabc123def" }))).toBe(true);
  });

  it("does NOT enable when EVM_PRIVATE_KEY is a placeholder token", () => {
    for (const v of [
      "REDACTED",
      "[PLACEHOLDER]",
      "TODO",
      "CHANGEME",
      "EMPTY",
      "  redacted  ",
    ]) {
      expect(shouldEnable(ctx({ EVM_PRIVATE_KEY: v }))).toBe(false);
    }
  });

  it("does NOT enable when SOLANA_PRIVATE_KEY is a placeholder token", () => {
    // The EVM path refuses placeholder tokens (REDACTED/PLACEHOLDER/TODO/...);
    // the Solana path must apply the same concrete-value guard so a redacted
    // secret cannot silently boot a wallet whose signing key is not a key.
    for (const v of ["REDACTED", "PLACEHOLDER", "TODO", "CHANGEME", "EMPTY"]) {
      expect(shouldEnable(ctx({ SOLANA_PRIVATE_KEY: v }))).toBe(false);
    }
  });

  it("enables when SOLANA_PRIVATE_KEY is a concrete value", () => {
    expect(
      shouldEnable(
        ctx({
          SOLANA_PRIVATE_KEY: "5KQ7m8xYwq3VfVrK9Jp1nTzQ2sLd4RbC6uHnEaXgMh",
        }),
      ),
    ).toBe(true);
  });

  it("requires BOTH steward URL and agent token for the EVM steward path", () => {
    expect(
      shouldEnable(ctx({ STEWARD_API_URL: "https://steward.example" })),
    ).toBe(false);
    expect(shouldEnable(ctx({ STEWARD_AGENT_TOKEN: "tok-123" }))).toBe(false);
    expect(
      shouldEnable(
        ctx({
          STEWARD_API_URL: "https://steward.example",
          STEWARD_AGENT_TOKEN: "tok-123",
        }),
      ),
    ).toBe(true);
  });

  it("honors the ELIZA_AGENT_WALLET_AUTO_ENABLE=0 opt-out even with a valid key", () => {
    expect(
      shouldEnable(
        ctx({
          ELIZA_AGENT_WALLET_AUTO_ENABLE: "0",
          EVM_PRIVATE_KEY: "0xabc123def",
        }),
      ),
    ).toBe(false);
  });

  it("respects explicit enabled:false on legacy entry names", () => {
    const config = {
      plugins: { entries: { solana: { enabled: false } } },
    };
    expect(shouldEnable(ctx({ EVM_PRIVATE_KEY: "0xabc123def" }, config))).toBe(
      false,
    );
  });

  it("the cloud-provisioned flag alone is not enough (requires exact '1' AND steward credentials)", () => {
    expect(shouldEnable(ctx({ ELIZA_CLOUD_PROVISIONED: "1" }))).toBe(false);
    expect(shouldEnable(ctx({ ELIZA_CLOUD_PROVISIONED: "true" }))).toBe(false);
    expect(
      shouldEnable(
        ctx({
          ELIZA_CLOUD_PROVISIONED: "1",
          STEWARD_API_URL: "https://steward.example",
          STEWARD_AGENT_TOKEN: "tok-123",
        }),
      ),
    ).toBe(true);
  });

  it("does NOT enable with no signing path at all", () => {
    expect(shouldEnable(ctx({}))).toBe(false);
    expect(shouldEnable(ctx({ SOLANA_PRIVATE_KEY: "" }))).toBe(false);
    expect(shouldEnable(ctx({ SOLANA_PRIVATE_KEY: "   " }))).toBe(false);
  });
});
