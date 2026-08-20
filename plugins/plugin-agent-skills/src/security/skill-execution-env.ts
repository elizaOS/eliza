/**
 * Builds the environment a skill script is spawned with.
 *
 * The inherited half is an ALLOWLIST because the threat is credentials that are
 * fleet-scoped rather than tenant-scoped — the shared server secret, the
 * local-KMS root key, the sandbox-registry Redis URL, the Steward service token,
 * the shared Postgres DSN. None is a spawn-injection primitive, so
 * `sanitizeSpawnEnv` neither does nor should remove them; only naming what may
 * pass keeps them out.
 *
 * The per-skill overlay is passed through `sanitizeSpawnEnv` as well. That
 * channel has no producer today — nothing calls `setSkillEnv` and the runtime
 * starts the service without `skillEntries` — so this is cheap insurance on an
 * API surface, not a live threat. Note it also means an overlay entry for
 * `PATH`, `HOME` or `SHELL` is now dropped where it used to win.
 *
 * Only `USE_SKILL` in script mode reaches this. Shell blocks in a SKILL.md are
 * run by the agent's own shell tool, so extend the allowlist from what skill
 * SCRIPTS read, not from what SKILL.md prose mentions.
 */
import { sanitizeSpawnEnv } from "@elizaos/core";

/** Process-level keys a child needs to run. None carries authority. */
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
 * The group that carries authority, so the one to guard: **do not add a
 * fleet-scoped key here.**
 *
 * `ELIZAOS_CLOUD_API_KEY` is admitted despite being platform-reserved because
 * the platform mints it per agent (`apiKeysService.createForAgent` in
 * `managed-eliza-config`), so a skill reading it reads its own agent's key.
 * Both base-URL spellings are present because the platform injects
 * `ELIZAOS_CLOUD_BASE_URL` while the bundled `eliza-cloud` skill documents
 * `ELIZA_CLOUD_BASE_URL`.
 */
const AGENT_SCOPED_ENV_KEYS = [
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
  "ELIZA_CLOUD_BASE_URL",
  "ELIZA_CLOUD_PUBLIC_URL",
  "ELIZA_CLOUD_URL",
  "ELIZA_APP_ID",
] as const;

/**
 * Credentials a bundled skill script reads or declares in `requires.env`
 * (`nano-banana-pro`, `tmux`, `notion`, `trello`, `things-mac`). Every entry is
 * a real read or a real declaration — an entry justified only by prose admits a
 * credential nothing uses.
 */
const SKILL_DECLARED_ENV_KEYS = [
  "GEMINI_API_KEY",
  "OTTO_TMUX_SOCKET_DIR",
  "NOTION_API_KEY",
  "TRELLO_API_KEY",
  "TRELLO_TOKEN",
  "THINGS_AUTH_TOKEN",
] as const;

const INHERITABLE_ENV_KEYS: ReadonlySet<string> = new Set<string>([
  ...HOST_ENV_KEYS,
  ...AGENT_SCOPED_ENV_KEYS,
  ...SKILL_DECLARED_ENV_KEYS,
]);

/**
 * Also consulted by the eligibility check, so a skill requiring a variable this
 * filter will not pass reports blocked instead of running without it.
 */
export function isInheritableSkillEnvKey(key: string): boolean {
  return INHERITABLE_ENV_KEYS.has(key.toUpperCase());
}

/**
 * @param processEnv parent environment, filtered by allowlist
 * @param overlay per-skill configured env, filtered by the spawn denylist
 */
export function buildSkillExecutionEnv(
  processEnv: NodeJS.ProcessEnv,
  overlay: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined && isInheritableSkillEnvKey(key))
      result[key] = value;
  }
  for (const [key, value] of Object.entries(sanitizeSpawnEnv(overlay))) {
    if (value !== undefined) result[key] = value;
  }

  // Without PATH, execvp falls back to a system default and bash synthesizes one
  // ending in `.`, so a skill shelling out to a bare command name would run a
  // same-named file from the working directory. A filter meant to remove
  // authority must not create that, so refuse rather than spawn.
  if (!result.PATH?.trim()) {
    throw new Error(
      "[agent-skills] refusing to run a skill script with no PATH: the child would resolve bare command names against a synthesized default",
    );
  }

  return result;
}
