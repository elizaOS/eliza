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

export async function resolveAllowedWorkdir(
  rawWorkdir: string,
): Promise<string> {
  const resolved = path.resolve(rawWorkdir);
  const resolvedReal = await realpath(resolved).catch(() => null);
  if (!resolvedReal) {
    throw new Error("workdir must exist");
  }

  const workspaceBaseDir = path.join(os.homedir(), ".eliza", "workspaces");
  const workspaceBaseDirResolved = path.resolve(workspaceBaseDir);
  const cwdResolved = path.resolve(process.cwd());
  const workspaceBaseDirReal = await realpath(workspaceBaseDirResolved).catch(
    () => workspaceBaseDirResolved,
  );
  const cwdReal = await realpath(cwdResolved).catch(() => cwdResolved);
  if (
    ![workspaceBaseDirReal, cwdReal].some((prefix) =>
      isInside(prefix, resolvedReal),
    )
  ) {
    throw new Error("workdir must be within workspace base directory or cwd");
  }

  return resolvedReal;
}
