/**
 * Enforces the platform-owned pairing mode for remotely hosted agent
 * containers at each environment handoff and immediately before Docker.
 */

/**
 * Suffixes of keys a caller must never place in a managed agent's container.
 * Each one hands caller-supplied input to something that then runs, or fetches
 * and then runs, code inside the container:
 *
 * - `TERMINAL_RUN_TOKEN` is what the terminal action reads from its own
 *   environment and replays as the token authorising the call, so it
 *   authenticates to itself. The platform never sets it; its absence IS the
 *   gate, which is why a caller who can set it opens command execution.
 * - the skills keys resolve where a skill is downloaded from and which
 *   directories are loaded without an install scan. Repointing one turns
 *   "install a skill" into "fetch and run caller-supplied code", and the
 *   scanner only reads JS/TS content, so a `.py` or `.sh` payload is executed
 *   having never been opened.
 *
 * Matched by suffix rather than exact name on purpose. `readAliasedEnv`
 * resolves a brand partner for every `ELIZA_*` key
 * (packages/shared/src/config/brand-env-aliases.ts carries
 * `TERMINAL_RUN_TOKEN`), and the brand prefix is deployment-configurable, so
 * `ELIZA_TERMINAL_RUN_TOKEN` and `<PREFIX>_TERMINAL_RUN_TOKEN` are the same
 * switch to the runtime. Pinning one spelling would leave the partner open.
 *
 * Removed here, rather than denied on the write routes, because a denylist on
 * those routes cannot hold: the stored `environment_vars` row is replayed
 * verbatim on every provision, restart and blue/green upgrade without
 * consulting one, and several create surfaces accept `environmentVars` with no
 * denylist at all. This function is the point every one of those paths funnels
 * through — the same reason ELIZA_CLOUD_PAIR_DIRECT_RELAY is stamped below
 * rather than merely reserved.
 */
const CALLER_FORBIDDEN_ENV_SUFFIXES = [
  // Shell execution. server-helpers-auth.ts reads this and the terminal action
  // replays it as its own authorisation.
  "TERMINAL_RUN_TOKEN",
  // Auth bypasses, each permissive when set. The stdio-MCP one is documented in
  // server-helpers-mcp.ts as the sibling of TERMINAL_RUN_TOKEN; DEV_AUTH_BYPASS
  // is honoured by loopback-trust.ts when NODE_ENV is a development value, which
  // a caller also supplies.
  "ALLOW_UNAUTHENTICATED_STDIO_MCP",
  "DEV_AUTH_BYPASS",
  "ALLOW_NULL_ORIGIN",
  // Self-modification: shared/self-edit.ts gates on ENABLE_SELF_EDIT, and
  // runtime.ts accepts DEV_MODE as the second half of the same condition.
  "ENABLE_SELF_EDIT",
  "DEV_MODE",
  // Capability routing sends tool execution to a caller-named endpoint.
  "CAPABILITY_ROUTER_URL",
  "CAPABILITY_ROUTER_URLS",
  "CAPABILITY_ROUTER_TOKEN",
  // Skill download origins and the directories that load without an install
  // scan. Documented plugin knobs for a self-hosted agent, which does not reach
  // this function — in a managed container they choose where fetched-and-run
  // code comes from, next to the platform's own credentials.
  "SKILLS_REGISTRY",
  "CLAWHUB_REGISTRY",
  "SKILLS_MARKETPLACE_URL",
  "WORKSPACE_SKILLS_DIR",
  "EXTRA_SKILLS_DIRS",
] as const;

function isCallerForbiddenEnvKey(key: string): boolean {
  const upper = key.trim().toUpperCase();
  return CALLER_FORBIDDEN_ENV_SUFFIXES.some(
    (suffix) => upper === suffix || upper.endsWith(`_${suffix}`),
  );
}

export function applyRemoteDockerRuntimeMode(
  environmentVars: Record<string, string>,
): Record<string, string> {
  const next: Record<string, string> = {
    ...environmentVars,
    ELIZA_CLOUD_PAIR_DIRECT_RELAY: "0",
  };
  for (const key of Object.keys(next)) {
    if (isCallerForbiddenEnvKey(key)) delete next[key];
  }
  return next;
}
