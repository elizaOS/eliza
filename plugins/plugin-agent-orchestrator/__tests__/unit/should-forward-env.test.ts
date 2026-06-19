import { describe, expect, it } from "vitest";
import {
  canonicalForwardedEnvKey,
  forwardableSubAgentEnv,
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

  // Regression: the repo runtime is Bun, and Bun on Windows reports the search
  // path as `Path` (and other OS vars with native casing), so a case-sensitive
  // `=== "PATH"` forwarded NONE of them — the child spawned with no PATH and the
  // opencode shim died with "'bun' is not recognized". Match case-insensitively.
  it("forwards PATH regardless of OS casing (Windows reports `Path`)", () => {
    expect(shouldForwardEnv("Path")).toBe(true);
    expect(shouldForwardEnv("path")).toBe(true);
    expect(isEnvForwardableToSubAgent("Path")).toBe(true);
  });

  it("forwards the Windows system vars cmd.exe + Bun + the agent need", () => {
    for (const key of [
      "PATHEXT",
      "SystemRoot",
      "windir",
      "ComSpec",
      "TEMP",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
    ]) {
      expect(shouldForwardEnv(key)).toBe(true);
    }
  });

  it("does not over-match vars that merely contain a system name", () => {
    expect(shouldForwardEnv("MY_PATH_OVERRIDE")).toBe(false);
    expect(shouldForwardEnv("PATHWAY")).toBe(false);
    expect(shouldForwardEnv("TEMP_TOKEN")).toBe(false);
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

// Canonicalization: OS system vars are forwarded under their uppercase form so a
// child never inherits two casings of the same var. Non-system keys are untouched.
describe("canonicalForwardedEnvKey", () => {
  it("uppercases OS system vars regardless of source casing", () => {
    expect(canonicalForwardedEnvKey("Path")).toBe("PATH");
    expect(canonicalForwardedEnvKey("path")).toBe("PATH");
    expect(canonicalForwardedEnvKey("Pathext")).toBe("PATHEXT");
    expect(canonicalForwardedEnvKey("SystemRoot")).toBe("SYSTEMROOT");
    expect(canonicalForwardedEnvKey("ProgramFiles")).toBe("PROGRAMFILES");
  });

  it("leaves non-system keys (prefix/allowlist vars) untouched", () => {
    expect(canonicalForwardedEnvKey("ELIZA_HOOK_PORT")).toBe("ELIZA_HOOK_PORT");
    expect(canonicalForwardedEnvKey("ANTHROPIC_API_KEY")).toBe(
      "ANTHROPIC_API_KEY",
    );
    expect(canonicalForwardedEnvKey("PARALLAX_SESSION_ID")).toBe(
      "PARALLAX_SESSION_ID",
    );
  });
});

// The pure host-env -> sub-agent-env projection buildEnv applies. This is the
// regression guard for the Windows/Bun bug: Bun reports the search path as
// `Path`, and a case-sensitive forward dropped it entirely.
describe("forwardableSubAgentEnv", () => {
  it("canonicalizes the Windows `Path` key to `PATH` (the bug)", () => {
    const out = forwardableSubAgentEnv({ Path: "C:\\bun;C:\\Windows" });
    expect(out.PATH).toBe("C:\\bun;C:\\Windows");
    expect(out.Path).toBeUndefined();
  });

  it("never emits two casings of the same OS var", () => {
    // A pathological env carrying both casings collapses to one canonical key.
    const out = forwardableSubAgentEnv({ Path: "/a", PATH: "/b" });
    expect(Object.keys(out).filter((k) => /^path$/i.test(k))).toEqual(["PATH"]);
    expect(out.Path).toBeUndefined();
  });

  it("forwards + canonicalizes the Windows system vars", () => {
    const out = forwardableSubAgentEnv({
      Pathext: ".COM;.EXE;.CMD",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    });
    expect(out.PATHEXT).toBe(".COM;.EXE;.CMD");
    expect(out.SYSTEMROOT).toBe("C:\\Windows");
    expect(out.COMSPEC).toBe("C:\\Windows\\System32\\cmd.exe");
  });

  it("keeps prefix/allowlist vars verbatim and drops denied + non-allowlisted", () => {
    const out = forwardableSubAgentEnv({
      ELIZA_HOOK_PORT: "2138",
      ANTHROPIC_API_KEY: "sk-x",
      ELIZA_VAULT_PASSPHRASE: "secret", // allowlisted by ELIZA_ but deny-listed
      DISCORD_BOT_TOKEN: "nope", // not allowlisted
      MISSING: undefined, // non-string skipped
    });
    expect(out.ELIZA_HOOK_PORT).toBe("2138");
    expect(out.ANTHROPIC_API_KEY).toBe("sk-x");
    expect(out.ELIZA_VAULT_PASSPHRASE).toBeUndefined();
    expect(out.DISCORD_BOT_TOKEN).toBeUndefined();
    expect("MISSING" in out).toBe(false);
  });
});
