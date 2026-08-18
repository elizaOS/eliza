/**
 * Verifies isDeniedSubAgentEnvKey (customCredentials deny-list).
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import { isDeniedSubAgentEnvKey } from "../../src/services/sub-agent-env-policy.js";

describe("isDeniedSubAgentEnvKey (customCredentials deny-list)", () => {
  it("denies connector bot tokens and the vault passphrase regardless of case", () => {
    for (const key of [
      "DISCORD_API_TOKEN",
      "TELEGRAM_BOT_TOKEN",
      "SLACK_BOT_TOKEN",
      "BOT_TOKEN",
      "ELIZA_CODE_CONFIG_CONTENT",
      "ELIZA_FCM_SERVICE_ACCOUNT",
      "ELIZA_AGENT_TOKEN_PRIVATE_KEY_PEM",
      "ELIZA_VOICE_CATALOG_SIGNING_KEY_BASE64",
      "ELIZA_MANAGED_DATABASE_URL",
      "ELIZA_VAULT_PASSPHRASE",
      "eliza_vault_passphrase",
      "TERMINAL_RUN_TOKEN",
      "ELIZA_TERMINAL_RUN_TOKEN",
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
      "PATH",
      "HOME",
      "ELIZA_RUNTIME_MODE",
      "ELIZA_CODE_BASE_URL",
      "ELIZA_CODE_MODEL_POWERFUL",
    ]) {
      expect(isDeniedSubAgentEnvKey(key)).toBe(false);
    }
  });
});
