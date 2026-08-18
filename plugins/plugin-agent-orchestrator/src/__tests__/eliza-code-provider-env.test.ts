/**
 * Verifies the deterministic provider-environment migration used for eliza-code
 * subprocesses without spawning a real coding agent.
 */
import { describe, expect, it } from "vitest";
import { applyElizaCodeProviderEnv } from "../services/eliza-code-provider-env.js";

describe("applyElizaCodeProviderEnv", () => {
  it("promotes legacy values and removes the retired names", () => {
    const env = {
      ELIZA_OPENCODE_API_KEY: "legacy-key",
      ELIZA_OPENCODE_BASE_URL: "https://legacy.example",
    };

    applyElizaCodeProviderEnv(env, () => undefined);

    expect(env).toEqual({
      ELIZA_CODE_API_KEY: "legacy-key",
      ELIZA_CODE_BASE_URL: "https://legacy.example",
    });
  });

  it("never lets a legacy value override a canonical value", () => {
    const env: NodeJS.ProcessEnv = {
      ELIZA_CODE_API_KEY: "canonical-key",
      ELIZA_OPENCODE_API_KEY: "adversarial-legacy-key",
    };

    applyElizaCodeProviderEnv(env, () => "config-value");

    expect(env.ELIZA_CODE_API_KEY).toBe("canonical-key");
    expect(env.ELIZA_OPENCODE_API_KEY).toBeUndefined();
  });

  it("uses canonical config before legacy config and ignores blanks", () => {
    const env: NodeJS.ProcessEnv = { ELIZA_CODE_LOCAL: "   " };
    const settings: Record<string, string> = {
      ELIZA_CODE_LOCAL: "true",
      ELIZA_OPENCODE_LOCAL: "false",
      ELIZA_OPENCODE_MODEL_FAST: "legacy-fast",
    };

    applyElizaCodeProviderEnv(env, (key) => settings[key]);

    expect(env.ELIZA_CODE_LOCAL).toBe("true");
    expect(env.ELIZA_CODE_MODEL_FAST).toBe("legacy-fast");
  });
});
