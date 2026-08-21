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
 * run by the agent's own shell tool, so credentials are inherited only when a
 * trusted bundled skill script declares them. A global credential allowlist
 * would hand every admitted secret to every installed script.
 */
import { ElizaError, sanitizeSpawnEnv } from "@elizaos/core";

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
 * Credentials a bundled executable script may inherit when that same skill
 * declares the key in `requires.env`. Guidance-only skills are deliberately
 * absent: their shell examples run through a different, already-brokered tool.
 */
const APPROVED_BUNDLED_SCRIPT_ENV_KEYS = [
  "GEMINI_API_KEY",
] as const;

const HOST_ENV_KEY_SET: ReadonlySet<string> = new Set<string>(HOST_ENV_KEYS);
const APPROVED_BUNDLED_SCRIPT_ENV_KEY_SET: ReadonlySet<string> =
  new Set<string>(APPROVED_BUNDLED_SCRIPT_ENV_KEYS);

function isCanonicalSkillEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    HOST_ENV_KEY_SET.has(upper) ||
    APPROVED_BUNDLED_SCRIPT_ENV_KEY_SET.has(upper)
  );
}

/**
 * Also consulted by the eligibility check, so a skill requiring a variable this
 * filter will not pass reports blocked instead of running without it.
 */
export function isInheritableSkillEnvKey(
  key: string,
  allowedCredentialKeys: readonly string[] = [],
): boolean {
  const upper = key.toUpperCase();
  if (HOST_ENV_KEY_SET.has(upper)) return true;
  return (
    APPROVED_BUNDLED_SCRIPT_ENV_KEY_SET.has(upper) &&
    allowedCredentialKeys.some((allowed) => allowed.toUpperCase() === upper)
  );
}

/**
 * @param processEnv parent environment, filtered by allowlist
 * @param overlay per-skill configured env, filtered by the spawn denylist
 * @param allowedCredentialKeys credentials declared by this trusted bundled skill
 */
export function buildSkillExecutionEnv(
  processEnv: NodeJS.ProcessEnv,
  overlay: Record<string, string>,
  allowedCredentialKeys: readonly string[] = [],
): Record<string, string> {
  const result: Record<string, string> = {};
  // Emit the allowlist's canonical spelling. This matters on Windows, where
  // the parent commonly exposes `Path`, and on POSIX, where a child reading
  // the documented uppercase key cannot see a mixed-case spelling.
  for (const [key, value] of Object.entries(processEnv)) {
    const canonicalKey = key.toUpperCase();
    if (
      value !== undefined &&
      key === canonicalKey &&
      isInheritableSkillEnvKey(canonicalKey, allowedCredentialKeys)
    ) {
      result[canonicalKey] = value;
    }
  }
  for (const [key, value] of Object.entries(processEnv)) {
    const canonicalKey = key.toUpperCase();
    if (
      value !== undefined &&
      result[canonicalKey] === undefined &&
      isInheritableSkillEnvKey(canonicalKey, allowedCredentialKeys)
    ) {
      result[canonicalKey] = value;
    }
  }
  for (const [key, value] of Object.entries(sanitizeSpawnEnv(overlay))) {
    if (value === undefined) continue;
    // Drop any inherited entry that differs only in case before writing. POSIX
    // treats `GEMINI_API_KEY` and `Gemini_Api_Key` as two variables, so an
    // exact-name overwrite would ship both and a child reading the documented
    // spelling would still get the ambient value — the opposite of overlay-wins.
    const upper = key.toUpperCase();
    const emittedKey = isCanonicalSkillEnvKey(upper) ? upper : key;
    for (const existing of Object.keys(result)) {
      if (existing !== emittedKey && existing.toUpperCase() === upper) {
        delete result[existing];
      }
    }
    result[emittedKey] = value;
  }

  // Without PATH, execvp falls back to a system default and bash synthesizes one
  // ending in `.`, so a skill shelling out to a bare command name would run a
  // same-named file from the working directory. A filter meant to remove
  // authority must not create that, so refuse rather than spawn.
  if (!result.PATH?.trim()) {
    throw new ElizaError(
      "[agent-skills] refusing to run a skill script with no PATH: the child would resolve bare command names against a synthesized default",
      { code: "SKILL_SCRIPT_PATH_UNAVAILABLE", severity: "fatal" },
    );
  }

  return result;
}
