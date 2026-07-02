import { describe, expect, it } from "vitest";
import { isDeniedSubAgentEnvKey } from "../../src/services/acp-service.ts";

describe("isDeniedSubAgentEnvKey (customCredentials deny-list)", () => {
  it("denies connector bot tokens and the vault passphrase regardless of case", () => {
    for (const key of [
      "DISCORD_API_TOKEN",
      "TELEGRAM_BOT_TOKEN",
      "SLACK_BOT_TOKEN",
      "BOT_TOKEN",
      "ELIZA_VAULT_PASSPHRASE",
      "eliza_vault_passphrase",
    ]) {
      expect(isDeniedSubAgentEnvKey(key)).toBe(true);
    }
  });

  it("denies broad GitHub host tokens but allows dedicated registry credentials", () => {
    for (const key of ["GITHUB_TOKEN", "GH_TOKEN", "CR_PAT"]) {
      expect(isDeniedSubAgentEnvKey(key)).toBe(true);
    }
    for (const key of [
      "GHCR_USERNAME",
      "GHCR_TOKEN",
      "ELIZA_APP_IMAGE_REGISTRY_USERNAME",
      "ELIZA_APP_IMAGE_REGISTRY_TOKEN",
    ]) {
      expect(isDeniedSubAgentEnvKey(key)).toBe(false);
    }
  });

  it("allows ordinary keys a caller may legitimately forward via customCredentials", () => {
    for (const key of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "CEREBRAS_API_KEY",
      "OPENCODE_CONFIG_CONTENT",
      "PATH",
      "HOME",
    ]) {
      expect(isDeniedSubAgentEnvKey(key)).toBe(false);
    }
  });
});
