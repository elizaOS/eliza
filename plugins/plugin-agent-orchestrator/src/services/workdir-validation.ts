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

/**
 * Walk up from `start` to the first directory containing a `.git` entry — the
 * toplevel of the repo the runtime itself runs from. Null when not in a repo.
 */
async function findGitToplevel(start: string): Promise<string | null> {
  let current = start;
  for (let i = 0; i < 40; i++) {
    // error-policy:J3 existence probe; absence just walks up.
    const hasGit = await realpath(path.join(current, ".git")).catch(() => null);
    if (hasGit) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

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

  // The runtime's OWN checkout is never a valid sub-agent workdir: a repo-task
  // agent handed the running code's repo will fetch/checkout/reset under the
  // live process (observed: a sub-agent checked out develop beneath the
  // running bot, and dev-mode hot-reload then bounced the runtime onto it).
  // The workspace base dir stays allowed even if nested inside the repo.
  // Operator-configured env roots inside the checkout are still refused on
  // purpose: no configuration may hand a sub-agent the running code's repo.
  const runtimeRepoRoot = await findGitToplevel(cwdReal);
  if (
    runtimeRepoRoot &&
    isInside(runtimeRepoRoot, resolvedReal) &&
    !isInside(workspaceBaseDirReal, resolvedReal)
  ) {
    throw new Error(
      `workdir must not be inside the runtime's own checkout (${runtimeRepoRoot}); use an isolated task workspace`,
    );
  }

  return resolvedReal;
}
