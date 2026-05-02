/**
 * Local GitHub credential storage for the eliza desktop / VPS install.
 *
 * Stores a single per-user GitHub PAT at
 * `<state-dir>/credentials/github.json` (chmod 600). The token itself is
 * write-only from the UI side: `loadCredentials()` returns the full record
 * for runtime consumers (orchestrator spawn env, route handlers) but the
 * HTTP route that powers the settings card never returns it — only
 * `getMetadata()` is safe to send back to the browser.
 *
 * Storage shape mirrors the convention used elsewhere under
 * `<state-dir>/` (see `~/.claude/.credentials.json` and the auth-store
 * module): plain JSON, file mode 600, no encryption layer. Encryption at
 * rest is a deliberately separate concern and would land in a follow-up.
 *
 * Cloud users (Eliza Cloud session active) are out of scope here — they
 * use the `platformCredentials` table in `cloud/packages/db/schemas/` via
 * the dedicated OAuth flow. This module is the local-first surface only.
 */

import fs from "node:fs/promises";
import path from "node:path";

export interface GitHubCredentials {
  /** The PAT itself. Never sent back to the UI after save. */
  token: string;
  /** The GitHub `login` returned by `GET api.github.com/user` at save time. */
  username: string;
  /**
   * Token scopes returned by GitHub's `X-OAuth-Scopes` response header at
   * save time. Recorded so the UI can show what the token is allowed to
   * do without round-tripping back to GitHub on every render.
   */
  scopes: string[];
  /** Wall-clock ms when the credential was saved. */
  savedAt: number;
}

/** Subset of {@link GitHubCredentials} that is safe to send to the UI. */
export type GitHubCredentialMetadata = Omit<GitHubCredentials, "token">;

function resolveStateDir(): string {
  const explicit = process.env.ELIZA_STATE_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  const home =
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim() ||
    process.cwd();
  return path.join(home, ".eliza");
}

/** Resolve the on-disk path for the credential file. */
export function getCredentialFilePath(): string {
  return path.join(resolveStateDir(), "credentials", "github.json");
}

function isGitHubCredentials(value: unknown): value is GitHubCredentials {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.token === "string" &&
    typeof v.username === "string" &&
    Array.isArray(v.scopes) &&
    v.scopes.every((s) => typeof s === "string") &&
    typeof v.savedAt === "number"
  );
}

/**
 * Read the saved credentials, or null if no file exists / the file is
 * unreadable / the contents don't conform to the expected shape. Callers
 * that need to surface a specific cause should check the file path
 * themselves; we treat all failure modes the same here so the UI never
 * has to reason about transient FS errors during render.
 */
export async function loadCredentials(): Promise<GitHubCredentials | null> {
  const filePath = getCredentialFilePath();
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isGitHubCredentials(parsed) ? parsed : null;
}

/** Read just the metadata: same as `loadCredentials` minus the token. */
export async function loadMetadata(): Promise<GitHubCredentialMetadata | null> {
  const creds = await loadCredentials();
  if (!creds) return null;
  const { token: _token, ...metadata } = creds;
  return metadata;
}

/**
 * Persist credentials to disk atomically with mode 0600. Creates the
 * parent directory if needed. Overwrites any existing record for the
 * single-user/single-token storage model.
 */
export async function saveCredentials(creds: GitHubCredentials): Promise<void> {
  const filePath = getCredentialFilePath();
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  // Write to a temp sibling then rename so an interrupted write can never
  // leave a half-written credential file readable by the runtime.
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(creds, null, 2), {
    mode: 0o600,
  });
  await fs.rename(tmpPath, filePath);
}

/**
 * Remove the credential file. Idempotent — succeeds silently when nothing
 * is saved. Any other FS error propagates so callers can surface it.
 */
export async function clearCredentials(): Promise<void> {
  const filePath = getCredentialFilePath();
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

/**
 * Build the credential record from a GitHub `/user` API response. Kept
 * tiny and pure so the route handler can call it without pulling in any
 * I/O surface. The route is responsible for the actual `fetch`.
 */
export function buildCredentialsFromUserResponse(
  token: string,
  user: { login: string },
  scopes: string[],
  now: number = Date.now(),
): GitHubCredentials {
  return {
    token,
    username: user.login,
    scopes,
    savedAt: now,
  };
}

/**
 * Resolve the canonical state-dir-respecting path for tests that need to
 * assert against the on-disk location without re-implementing the
 * resolver.
 */
export function _resolveStateDirForTests(): string {
  return resolveStateDir();
}

export interface ApplySavedTokenResult {
  /** True when a saved token was found and copied into process.env. */
  applied: boolean;
  /**
   * True when `process.env.GITHUB_TOKEN` was already set before this call.
   * The existing value is left untouched — explicit env always wins.
   */
  envAlreadySet: boolean;
  /** Username from the saved record, surfaced for boot logging. */
  username?: string;
}

/**
 * Read the saved credential and copy the token into `process.env.GITHUB_TOKEN`
 * when no explicit env value is already set. Called once at runtime
 * bootstrap so the orchestrator's existing `runtime.getSetting("GITHUB_TOKEN")`
 * resolution and any `gh`/`git` invocation in spawned PTY sessions both see
 * the same value without each having to know about the on-disk record.
 *
 * Existing `process.env.GITHUB_TOKEN` always wins — a developer's shell
 * export should override the persisted UI value.
 */
export async function applySavedTokenToEnv(): Promise<ApplySavedTokenResult> {
  if (process.env.GITHUB_TOKEN?.trim()) {
    return { applied: false, envAlreadySet: true };
  }
  const creds = await loadCredentials();
  if (!creds) {
    return { applied: false, envAlreadySet: false };
  }
  process.env.GITHUB_TOKEN = creds.token;
  return { applied: true, envAlreadySet: false, username: creds.username };
}
