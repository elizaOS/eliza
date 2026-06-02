import { describe, expect, it } from "vitest";
import {
  isEnvForwardableToSubAgent,
  shouldForwardEnv,
} from "../../src/services/acp-service.js";

// Guards buildEnv's sealed-env allowlist. It is an allowlist (anything not
// matched is denied), so the risk is twofold: a needed var silently dropped, or
// a secret silently forwarded. The load-bearing case is PARALLAX_SESSION_ID —
// without it the loopback /api/coding-agents/<id>/* parent-context bridge is
// unreachable from an ACP-spawned sub-agent (it does NOT ride the ELIZA_ prefix).
describe("shouldForwardEnv", () => {
  it("forwards PARALLAX_SESSION_ID (the parent-context bridge id)", () => {
    expect(shouldForwardEnv("PARALLAX_SESSION_ID")).toBe(true);
  });

  it("forwards every ELIZA_-prefixed var (e.g. ELIZA_HOOK_PORT)", () => {
    expect(shouldForwardEnv("ELIZA_HOOK_PORT")).toBe(true);
    expect(shouldForwardEnv("ELIZA_ACP_WORKSPACE_ROOT")).toBe(true);
  });

  it("forwards the model/auth vars the backends need", () => {
    expect(shouldForwardEnv("ANTHROPIC_API_KEY")).toBe(true);
    expect(shouldForwardEnv("OPENAI_API_KEY")).toBe(true);
    expect(shouldForwardEnv("CEREBRAS_BASE_URL")).toBe(true);
    expect(shouldForwardEnv("PATH")).toBe(true);
  });

  it("forwards ACPX_AUTH_-prefixed vars", () => {
    expect(shouldForwardEnv("ACPX_AUTH_TOKEN")).toBe(true);
  });

  it("denies secrets that are not on the allowlist (default-deny)", () => {
    expect(shouldForwardEnv("DISCORD_BOT_TOKEN")).toBe(false);
    expect(shouldForwardEnv("BOT_TOKEN")).toBe(false);
    expect(shouldForwardEnv("AWS_SECRET_ACCESS_KEY")).toBe(false);
    expect(shouldForwardEnv("GITHUB_TOKEN")).toBe(false);
  });
});

// The effective per-var decision buildEnv applies: deny-list BEFORE allowlist.
// This is the layer that strips privileged host secrets which would otherwise
// ride the broad ELIZA_ prefix into a sub-agent.
describe("isEnvForwardableToSubAgent (deny-then-allow)", () => {
  it("strips host secrets even though they match the allowlist", () => {
    // Each of these IS allowlisted (ELIZA_ prefix / *TOKEN) — the deny-list wins.
    for (const key of [
      "ELIZA_VAULT_PASSPHRASE",
      "ELIZA_TERMINAL_RUN_TOKEN",
      "DISCORD_BOT_TOKEN",
    ]) {
      expect(isEnvForwardableToSubAgent(key)).toBe(false);
    }
  });

  it("documents why the combined predicate exists: ELIZA_TERMINAL_RUN_TOKEN is allowlisted but denied", () => {
    // The host-API shell-exec credential matches shouldForwardEnv via ELIZA_…
    expect(shouldForwardEnv("ELIZA_TERMINAL_RUN_TOKEN")).toBe(true);
    // …but must never reach a sub-agent, so the effective decision is false.
    expect(isEnvForwardableToSubAgent("ELIZA_TERMINAL_RUN_TOKEN")).toBe(false);
  });

  it("still forwards the bridge id and the vars a sub-agent legitimately needs", () => {
    expect(isEnvForwardableToSubAgent("PARALLAX_SESSION_ID")).toBe(true);
    expect(isEnvForwardableToSubAgent("ELIZA_HOOK_PORT")).toBe(true);
    expect(isEnvForwardableToSubAgent("ANTHROPIC_API_KEY")).toBe(true);
    expect(isEnvForwardableToSubAgent("PATH")).toBe(true);
  });
});
