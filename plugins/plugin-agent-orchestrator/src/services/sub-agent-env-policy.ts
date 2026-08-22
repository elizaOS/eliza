/**
 * Environment forwarding policy for coding sub-agent spawns. The ACP service
 * consumes this as the single host-env projection before adding per-session
 * model gateway, credential bridge, and adapter-specific overrides.
 */
const DENY_ENV_PATTERNS = [
  /DISCORD.*TOKEN/i,
  /TELEGRAM.*TOKEN/i,
  /SLACK.*TOKEN/i,
  /BOT.*TOKEN/i,
  /ELIZA_VAULT_PASSPHRASE/i,
  // Host-API shell-exec / stdio-MCP auth secret — consumed only by
  // packages/agent/src/api/*, never by a coding sub-agent. Forwarding it would
  // hand a child process a credential that re-authorizes arbitrary host command
  // execution with zero legitimate use for it.
  /TERMINAL_RUN_TOKEN/i,
  // One-time authenticator for a session-less warm ACP child. Only the pool
  // bootstrap may inject it; host or caller forwarding would defeat the claim
  // boundary and could make a cold child accept session metadata.
  /^ELIZA_ACP_WARM_CLAIM_TOKEN$/i,
  // Repo-scoped GitHub host credentials must not be injected into sub-agents,
  // including through customCredentials. Registry push uses the dedicated
  // GHCR_* or ELIZA_APP_IMAGE_REGISTRY_* names instead.
  /^(?:GITHUB_TOKEN|GH_TOKEN|CR_PAT|GH_PAT)$/i,
  // OpenCode's spawn config is runtime-built (buildOpencodeAcpEnv overwrites it
  // AFTER this filter runs). A caller- or host-supplied value would let the
  // spawner inject arbitrary provider config into the child, so it is denied at
  // both intake paths.
];

/**
 * A key that must never reach a sub-agent, regardless of source — parent
 * process.env forwarding OR caller-supplied customCredentials. Both paths run
 * through this so a spawn request cannot inject a secret (connector bot token,
 * vault passphrase) the deny-list exists to keep out of sub-agents.
 */
export function isDeniedSubAgentEnvKey(key: string): boolean {
  return DENY_ENV_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * OS-level environment variables a spawned coding agent needs to function.
 * Matched case-insensitively (see `shouldForwardEnv`): the repo runtime is Bun,
 * and Bun on Windows reports these with native casing — `Path`, not `PATH` —
 * so a case-sensitive check would forward NONE of them, leaving the child with
 * no search path (the opencode shim then fails with "'bun' is not recognized").
 * Includes the Windows essentials cmd.exe + Bun + the agent's config/cache
 * resolution rely on, alongside the POSIX names.
 */
export const SUB_AGENT_SYSTEM_ENV_KEYS = [
  "PATH",
  "PATHEXT",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  // Windows essentials.
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "SYSTEMDRIVE",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "COMMONPROGRAMFILES",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "USERNAME",
  "USERDOMAIN",
] as const;

const FORWARDED_SYSTEM_ENV: ReadonlySet<string> = new Set(
  SUB_AGENT_SYSTEM_ENV_KEYS,
);

/**
 * Provider and adapter configuration keys that are intentionally forwarded even
 * without an `ELIZA_` prefix. Keep this list narrow: each entry is a runtime
 * dependency for a supported coding backend or the app-image registry push path.
 */
export const SUB_AGENT_PROVIDER_ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  // OpenAI twins of the Anthropic proxy/tier forwarding (#16562): a parent on
  // a third-party OpenAI-compatible endpoint must not spawn children that
  // silently talk to api.openai.com with default tier models.
  "OPENAI_BASE_URL",
  "OPENAI_SMALL_MODEL",
  "OPENAI_LARGE_MODEL",
  "CEREBRAS_API_KEY",
  "CEREBRAS_BASE_URL",
  "CEREBRAS_MODEL",
  "OPENAI_MODEL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_MODEL",
  "ANTHROPIC_MEDIUM_MODEL",
  "ANTHROPIC_LARGE_MODEL",
  // Claude Code CLI reasoning-effort knob; buildEnv also sets it from the
  // validated config-env ELIZA_CLAUDE_EFFORT for claude spawns.
  "CLAUDE_CODE_EFFORT_LEVEL",
  "CODEX_HOME",
  // Container-registry PUSH credential for app-image builds (docker login
  // ghcr.io before the deploy contract's docker push). Narrow by design:
  // these are the dedicated registry-scoped names (a packages:write PAT),
  // mirrored cloud-side by containersEnv.registryUsername()/registryToken().
  // The broad GITHUB_TOKEN / GH_TOKEN / CR_PAT stay DENIED — a repo-scoped
  // host token must never ride into a sub-agent. The canonical
  // ELIZA_APP_IMAGE_REGISTRY_USERNAME/_TOKEN pair already forwards via the
  // ELIZA_ prefix above.
  "GHCR_USERNAME",
  "GHCR_TOKEN",
] as const;

const PROVIDER_ENV: ReadonlySet<string> = new Set(SUB_AGENT_PROVIDER_ENV_KEYS);

/**
 * The key a forwarded var is assigned under. OS system vars are canonicalized to
 * their uppercase `FORWARDED_SYSTEM_ENV` form because Bun on Windows reports them
 * with native casing (`Path`, `Pathext`, `SystemRoot`, `ProgramFiles`, …); a
 * child must not inherit two casings of the same var (the winner is undefined on
 * Windows), and JS consumers that read `env.PATH` case-sensitively need the
 * canonical key. Non-system keys (ELIZA_*, API keys, model overrides) keep their
 * original casing.
 */
export function canonicalForwardedEnvKey(key: string): string {
  return FORWARDED_SYSTEM_ENV.has(key.toUpperCase()) ? key.toUpperCase() : key;
}

/** Parse the explicit operator opt-in for forwarding raw `ELIZAOS_CLOUD*`
 * credentials. The caller supplies the config-backed value so this policy
 * module remains pure and independently testable. Default remains OFF. */
export function isCloudKeyForwardingOptIn(raw: string | undefined): boolean {
  const normalized = raw?.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

/**
 * The per-var forwarding predicate. `forwardCloudKey` (default false) opts a
 * spawn into forwarding the owner's raw `ELIZAOS_CLOUD*` creds — pure so the
 * gate is unit-testable without touching config; `forwardableSubAgentEnv`
 * resolves the flag from config-env once per build.
 */
export function shouldForwardEnv(
  key: string,
  forwardCloudKey = false,
): boolean {
  return (
    FORWARDED_SYSTEM_ENV.has(key.toUpperCase()) ||
    key.startsWith("ACPX_AUTH_") ||
    key.startsWith("ELIZA_") ||
    // The live Cloud creds use the ELIZAOS_ prefix (ELIZAOS_CLOUD_API_KEY /
    // ELIZAOS_CLOUD_URL), which the broad ELIZA_ rule above does NOT match.
    // Broker-first (#14118): a child does NOT get the raw owner key by default —
    // it registers/deploys via the parent broker (spend-gated) and fetches any
    // container-runtime secret via the owner-approved credential bridge. Only the
    // explicit ELIZA_FORWARD_CLOUD_KEY_TO_SUBAGENTS opt-in restores raw forwarding.
    (forwardCloudKey && key.startsWith("ELIZAOS_CLOUD")) ||
    PROVIDER_ENV.has(key)
  );
}

/**
 * The single forwarding decision buildEnv applies per host env var: the
 * deny-list wins over the allowlist. A few keys (the privileged host secrets in
 * DENY_ENV_PATTERNS) match shouldForwardEnv — e.g. via the broad ELIZA_ prefix —
 * yet must never reach a coding sub-agent, so the deny check runs first.
 */
export function isEnvForwardableToSubAgent(
  key: string,
  forwardCloudKey = false,
): boolean {
  if (isDeniedSubAgentEnvKey(key)) return false;
  return shouldForwardEnv(key, forwardCloudKey);
}

/**
 * The deny-list-filtered, allowlisted, casing-canonicalized subset of `source`
 * to forward to a coding sub-agent. Pure (no process.env read) so it is unit
 * testable: pass a synthetic env (e.g. `{ Path: "…" }`, the casing Bun reports
 * on Windows) and assert the result is keyed by `PATH`. See
 * `canonicalForwardedEnvKey` for why OS vars are canonicalized.
 */
export function forwardableSubAgentEnv(
  source: Record<string, string | undefined>,
  forwardCloudKey = false,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    if (!isEnvForwardableToSubAgent(key, forwardCloudKey)) continue;
    out[canonicalForwardedEnvKey(key)] = value;
  }
  return out;
}
