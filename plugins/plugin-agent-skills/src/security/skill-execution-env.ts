/**
 * Builds the environment a skill script is spawned with.
 *
 * Two different threats need two different filters here, which is why this is
 * not one denylist.
 *
 * The inherited half is an ALLOWLIST. In a managed cloud container the agent
 * process environment carries credentials whose authority is fleet-wide rather
 * than tenant-scoped — the shared server secret that authenticates to every
 * tenant's agent container, the local-KMS root key that re-derives every
 * organisation's DEK, the sandbox-registry Redis URL, the Steward service token
 * that mints a JWT for any agent id, and the shared Postgres DSN. None of those
 * is a spawn-injection primitive, so `sanitizeSpawnEnv` does not and should not
 * remove them. Only naming what may pass keeps them out.
 *
 * The per-skill overlay is a DENYLIST. `setSkillEnv` accepts arbitrary keys with
 * no validation, so a skill's own configuration can carry `LD_PRELOAD`,
 * `NODE_OPTIONS`, `BASH_FUNC_*` and the rest. That is exactly the class
 * `sanitizeSpawnEnv` exists for.
 *
 * PATH is on the allowlist rather than re-derived: the spawn sites use bare
 * `python3` / `bash` / `node`, so an environment without a usable PATH breaks
 * every skill rather than securing it. Inheriting the parent's PATH keeps that
 * behaviour byte-identical to what it was before this filter existed, which is
 * the conservative choice for a change whose point is to remove things.
 */
import { sanitizeSpawnEnv } from "@elizaos/core";

/**
 * Process-level keys a child needs to run at all. Nothing here identifies the
 * platform or authorises anything against it.
 */
const HOST_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SHELL",
  "TERM",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
] as const;

/**
 * Agent-scoped identity. These are reserved platform keys, and they are on this
 * list deliberately: `ELIZAOS_CLOUD_API_KEY` is minted per agent by
 * `apiKeysService.createForAgent(org, user, sandbox)`, so a skill reading it
 * reads its OWN agent's key, not a shared one. The bundled `eliza-cloud`,
 * `eliza-cloud-buy-domain`, `eliza-cloud-manage-domain` and
 * `build-monetized-app` skills document reading them. Do not add a
 * fleet-scoped key to this list — that is the distinction the whole file turns on.
 */
const AGENT_SCOPED_ENV_KEYS = [
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZA_CLOUD_BASE_URL",
  "ELIZA_CLOUD_PUBLIC_URL",
  "ELIZA_CLOUD_URL",
  "ELIZA_APP_ID",
] as const;

/**
 * Third-party credentials the bundled skills document reading from the ambient
 * environment. These belong to the user's own integrations, not to the
 * platform. A skill added later should carry its credential through the
 * per-skill env channel instead of extending this list, which is why the list
 * is explicit rather than a pattern.
 */
const SKILL_DOCUMENTED_ENV_KEYS = [
  "GEMINI_API_KEY",
  "NOTION_KEY",
  "NOTION_API_KEY",
  "TRELLO_API_KEY",
  "TRELLO_TOKEN",
  "THINGS_AUTH_TOKEN",
  "SUNO_API_KEY",
  "SUNO_BASE_URL",
  "OTTO_TMUX_SOCKET_DIR",
] as const;

const INHERITABLE_ENV_KEYS: ReadonlySet<string> = new Set<string>([
  ...HOST_ENV_KEYS,
  ...AGENT_SCOPED_ENV_KEYS,
  ...SKILL_DOCUMENTED_ENV_KEYS,
]);

export function isInheritableSkillEnvKey(key: string): boolean {
  return INHERITABLE_ENV_KEYS.has(key.trim().toUpperCase());
}

/**
 * @param processEnv the parent environment to inherit from, filtered by allowlist
 * @param overlay per-skill configured env, filtered by the spawn denylist
 */
export function buildSkillExecutionEnv(
  processEnv: NodeJS.ProcessEnv,
  overlay: Record<string, string>,
): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined && isInheritableSkillEnvKey(key)) {
      inherited[key] = value;
    }
  }

  const safeOverlay = sanitizeSpawnEnv(overlay);
  const result: Record<string, string> = { ...inherited };
  for (const [key, value] of Object.entries(safeOverlay)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}
