/**
 * Unit tests for sub-agent environment policy: validates deny list regex matching
 * and system essential keys.
 */
import { describe, expect, it } from "vitest";
import {
  isDeniedSubAgentEnvKey,
  SUB_AGENT_SYSTEM_ENV_KEYS,
} from "./sub-agent-env-policy.ts";

describe("sub-agent-env-policy", () => {
  it("denies sensitive tokens and credentials", () => {
    expect(isDeniedSubAgentEnvKey("DISCORD_API_TOKEN")).toBe(true);
    expect(isDeniedSubAgentEnvKey("TELEGRAM_BOT_TOKEN")).toBe(true);
    expect(isDeniedSubAgentEnvKey("SLACK_BOT_TOKEN")).toBe(true);
    expect(isDeniedSubAgentEnvKey("ELIZA_VAULT_PASSPHRASE")).toBe(true);
    expect(isDeniedSubAgentEnvKey("GITHUB_TOKEN")).toBe(true);
    expect(isDeniedSubAgentEnvKey("TERMINAL_RUN_TOKEN")).toBe(true);
  });

  it("allows harmless operational environment variables", () => {
    expect(isDeniedSubAgentEnvKey("NODE_ENV")).toBe(false);
    expect(isDeniedSubAgentEnvKey("PORT")).toBe(false);
    expect(isDeniedSubAgentEnvKey("PATH")).toBe(false);
  });

  it("includes core OS keys in system list", () => {
    expect(SUB_AGENT_SYSTEM_ENV_KEYS).toContain("PATH");
    expect(SUB_AGENT_SYSTEM_ENV_KEYS).toContain("HOME");
    expect(SUB_AGENT_SYSTEM_ENV_KEYS).toContain("USER");
  });
});
