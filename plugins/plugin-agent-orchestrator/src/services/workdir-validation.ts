/**
 * Workdir validation keeps auto-spawned coding agents inside the configured
 * workspace sandbox. It expands the default per-task workspace under
 * `~/.eliza/workspaces`, resolves symlinks before comparison, and rejects
 * caller-supplied directories outside the allowed roots.
 */

import { mkdir, realpath } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

function isInside(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

/**
 * Default per-task workdir for an auto-spawned coding agent:
 * `~/.eliza/workspaces/<taskId>`, created if missing. Always inside the allowed
 * workspace base (see {@link resolveAllowedWorkdir}), so messaging a task can
 * spawn an agent without a caller-supplied workdir — the parity-with-claude/codex
 * "just message it and it works" path relies on this.
 */
export async function ensureTaskWorkdir(taskId: string): Promise<string> {
  const dir = path.resolve(
    path.join(os.homedir(), ".eliza", "workspaces", taskId),
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Configured workspace-root env keys, in the same precedence the spawn path
 * (`resolveDefaultSpawnWorkdir` in task-agent-routing.ts) honors. An operator
 * who points the runtime at a coding workspace (e.g. ELIZA_WORKSPACE_DIR or
 * ELIZA_ACP_WORKSPACE_ROOT = /workspace) expects HTTP-spawned agents to be
 * allowed to run THERE, not only under ~/.eliza/workspaces or process.cwd().
 * Reading from process.env here keeps this validator runtime-handle-free.
 */
const WORKSPACE_ROOT_ENV_KEYS = [
  "ELIZA_ACP_WORKSPACE_ROOT",
  "ACPX_DEFAULT_CWD",
  "ELIZA_WORKSPACE_DIR",
  "ELIZA_CODING_WORKSPACE",
  "ELIZA_CODING_DIRECTORY",
] as const;

export async function resolveAllowedWorkdir(
  rawWorkdir: string,
): Promise<string> {
  const resolved = path.resolve(rawWorkdir);
  // error-policy:J3 existence probe — a non-resolvable path is an explicit
  // "absent" (null); the failure is surfaced by the throw immediately below.
  const resolvedReal = await realpath(resolved).catch(() => null);
  if (!resolvedReal) {
    throw new Error("workdir must exist");
  }

  const workspaceBaseDir = path.join(os.homedir(), ".eliza", "workspaces");
  const workspaceBaseDirResolved = path.resolve(workspaceBaseDir);
  const cwdResolved = path.resolve(process.cwd());
  // error-policy:J3 canonicalize the base root; a not-yet-created root degrades
  // to its lexical resolved form for the prefix comparison below.
  const workspaceBaseDirReal = await realpath(workspaceBaseDirResolved).catch(
    () => workspaceBaseDirResolved,
  );
  // error-policy:J3 canonicalize cwd; falls back to its lexical resolved form if
  // realpath can't resolve it.
  const cwdReal = await realpath(cwdResolved).catch(() => cwdResolved);

  // Also allow any explicitly-configured workspace root. This keeps the HTTP
  // task-agent spawn path (which calls this validator) consistent with the
  // chat-action spawn path, which already lands sessions under the configured
  // root. Without this, a configured /workspace root is rejected as "not within
  // workspace base directory or cwd" even though the operator set it.
  const configuredRoots: string[] = [];
  for (const key of WORKSPACE_ROOT_ENV_KEYS) {
    const raw = process.env[key]?.trim();
    if (!raw) continue;
    const rootResolved = path.resolve(raw);
    // error-policy:J3 canonicalize a configured root; a not-yet-created root
    // degrades to its lexical resolved form for the prefix comparison.
    const rootReal = await realpath(rootResolved).catch(() => rootResolved);
    configuredRoots.push(rootReal);
  }

  const allowedPrefixes = [workspaceBaseDirReal, cwdReal, ...configuredRoots];
  if (!allowedPrefixes.some((prefix) => isInside(prefix, resolvedReal))) {
    throw new Error("workdir must be within workspace base directory or cwd");
  }

  return resolvedReal;
}
