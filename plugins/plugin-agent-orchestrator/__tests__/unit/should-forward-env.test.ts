import { describe, expect, it } from "vitest";
import {
  isDeniedSubAgentEnvKey,
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

// buildEnv runs the deny-list (isDeniedSubAgentEnvKey) BEFORE the allowlist, so a
// privileged host secret that would otherwise ride the broad ELIZA_ prefix into a
// sub-agent is stripped first. This guards that layer.
describe("isDeniedSubAgentEnvKey (deny-list wins over the allowlist)", () => {
  it("denies host secrets even though they match the allowlist", () => {
    // Each of these IS allowlisted (ELIZA_ prefix / *TOKEN) — the deny-list wins.
    for (const key of [
      "ELIZA_VAULT_PASSPHRASE",
      "ELIZA_TERMINAL_RUN_TOKEN",
      "DISCORD_BOT_TOKEN",
    ]) {
      expect(isDeniedSubAgentEnvKey(key)).toBe(true);
    }
  });

  it("denies ELIZA_TERMINAL_RUN_TOKEN even though the allowlist would forward it", () => {
    // The host-API shell-exec credential matches shouldForwardEnv via ELIZA_…
    expect(shouldForwardEnv("ELIZA_TERMINAL_RUN_TOKEN")).toBe(true);
    // …but the deny-list strips it before the allowlist is consulted.
    expect(isDeniedSubAgentEnvKey("ELIZA_TERMINAL_RUN_TOKEN")).toBe(true);
  });

  it("does not deny the bridge id or the vars a sub-agent legitimately needs", () => {
    expect(isDeniedSubAgentEnvKey("PARALLAX_SESSION_ID")).toBe(false);
    expect(isDeniedSubAgentEnvKey("ELIZA_HOOK_PORT")).toBe(false);
    expect(isDeniedSubAgentEnvKey("ANTHROPIC_API_KEY")).toBe(false);
    expect(isDeniedSubAgentEnvKey("PATH")).toBe(false);
  });
});
