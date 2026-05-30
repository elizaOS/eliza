import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const MAX_DIFF_CHARS = 6_000;
const MAX_CHANGED_FILES = 60;
const MAX_FILE_DIFFS = 12;

function outputToString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return undefined;
}

/**
 * What a sub-agent actually changed in its workspace, captured as ground
 * truth from git (plus the agent's own edit/write tool calls) rather than from
 * the model's frequently-confabulated description of its work. Persisted on
 * session metadata at `task_complete` so the parent can answer "what did you
 * change / show me the diff" from the real change set.
 */
export interface WorkspaceChangeSet {
  changedFiles: string[];
  diffStat: string;
  diff: string;
  truncated: boolean;
  capturedAt: number;
}

async function git(
  workdir: string,
  args: string[],
): Promise<string | undefined> {
  const direct = spawnSync("git", args, {
    cwd: workdir,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
  });
  const directStdout = outputToString(direct.stdout);
  if (directStdout && directStdout.length > 0) return directStdout;

  // Bun's test runner can report a successful git process with an empty stdout
  // pipe. In that environment only, ask the shell to redirect stdout itself.
  if (direct.status !== 0 && !process.versions.bun) return undefined;
  if (!process.versions.bun) return directStdout;

  const outDir = mkdtempSync(join(tmpdir(), "workspace-diff-git-"));
  const outPath = join(outDir, "stdout");
  writeFileSync(outPath, "");
  const result = spawnSync(
    "sh",
    ["-c", 'git "$@" > "$WORKSPACE_DIFF_GIT_STDOUT"', "git", ...args],
    {
      cwd: workdir,
      env: { ...process.env, WORKSPACE_DIFF_GIT_STDOUT: outPath },
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    },
  );

  // `git diff --no-index` exits 1 when files differ — that's the success case
  // for us and the diff is on stdout. Everything else (not a repo, git missing,
  // detached state) is best-effort: change capture must never disturb the
  // session lifecycle.
  try {
    const stdout = readFileSync(outPath, "utf8");
    if (result.status === 0 || stdout.length > 0) return stdout;
    return undefined;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

async function isWorkTree(workdir: string): Promise<boolean> {
  const inside = await git(workdir, ["rev-parse", "--is-inside-work-tree"]);
  return inside?.trim() === "true";
}

/**
 * The repo HEAD at spawn time, so the change set at completion is scoped to
 * exactly what this sub-agent did (committed or not). Undefined when the
 * workspace is not a git work tree or has no commits yet.
 */
export async function captureBaselineSha(
  workdir: string,
): Promise<string | undefined> {
  if (!(await isWorkTree(workdir))) return undefined;
  const sha = await git(workdir, ["rev-parse", "HEAD"]);
  return sha?.trim() || undefined;
}

/**
 * Tracked files already modified in the workspace at spawn time. The completion
 * diff (`git diff <baseline>`) compares the working tree to the baseline
 * COMMIT, so files that were dirty BEFORE the session (a leftover edit, a dirty
 * submodule pointer) show up even though this sub-agent never touched them.
 * Recording them at spawn lets the change set exclude that pre-existing churn.
 */
export async function captureBaselineDirty(workdir: string): Promise<string[]> {
  if (!(await isWorkTree(workdir))) return [];
  return ((await git(workdir, ["diff", "--name-only", "HEAD"])) ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Parse `git diff --name-status` output into the set of affected paths. Renames
 * appear as `R100\told\tnew` — the post-rename path is what changed, so take
 * the last tab-separated field for every status.
 */
function parseNameStatus(out: string | undefined): string[] {
  const files: string[] = [];
  for (const line of (out ?? "").split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const path = parts[parts.length - 1]?.trim();
    if (path) files.push(path);
  }
  return files;
}

/** Normalize a tool-call file path to workdir-relative POSIX form. */
function toWorkdirRelative(workdir: string, file: string): string {
  const trimmed = file.trim();
  if (!trimmed) return "";
  const absolute = isAbsolute(trimmed) ? trimmed : resolve(workdir, trimmed);
  const rel = relative(workdir, absolute);
  const normalized = rel.split("\\").join("/");
  if (
    !normalized ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    isAbsolute(normalized)
  ) {
    return "";
  }
  return normalized;
}

/** Unified diff for one file: real git diff if tracked, else new-file diff. */
async function fileDiff(
  workdir: string,
  base: string,
  file: string,
): Promise<string> {
  const tracked = (await git(workdir, ["diff", base, "--", file]))?.trim();
  if (tracked) return tracked;
  const created = (
    await git(workdir, ["diff", "--no-index", "--", "/dev/null", file])
  )?.trim();
  return created ?? "";
}

/**
 * What this sub-agent changed in `workdir` since spawn, from the union of two
 * SESSION-SCOPED signals — no filesystem walk, no path denylist, no mtime
 * heuristics, so it works for any workdir/language/deployment:
 *  - `git diff --name-status <base>`: tracked edits, deletions, renames since
 *    the spawn baseline (covers shell-driven writes to tracked files);
 *  - `toolPaths`: files the agent explicitly wrote via edit/write tool calls
 *    this session — including gitignored DEPLOY targets (`data/apps/<name>/`)
 *    that git won't surface.
 *
 * Deliberately NOT using `git ls-files --others`: it lists EVERY untracked file
 * in the work tree regardless of when it appeared, so in a shared/long-lived
 * workspace it scoops up accumulated clutter from prior sessions (stray .venv,
 * old build output, scratch PDFs) that this task never touched. Both signals
 * above are scoped to this session, so the change set stays accurate.
 *
 * Returns undefined when nothing changed or the workspace isn't a git repo.
 */
export async function captureChangeSet(
  workdir: string,
  baselineSha?: string,
  toolPaths: string[] = [],
  baselineDirty: string[] = [],
): Promise<WorkspaceChangeSet | undefined> {
  if (!(await isWorkTree(workdir))) return undefined;
  const base = baselineSha?.trim() ? baselineSha.trim() : "HEAD";

  // Exclude files already dirty at spawn (pre-existing churn the agent didn't
  // touch) UNLESS the agent explicitly wrote them via a tool call this session.
  const agentWrittenSet = new Set(
    toolPaths
      .map((file) => toWorkdirRelative(workdir, file))
      .filter((file) => file.length > 0),
  );
  const dirtyAtSpawn = new Set(
    baselineDirty.filter((file) => !agentWrittenSet.has(file)),
  );
  const tracked = parseNameStatus(
    await git(workdir, ["diff", "--name-status", base]),
  ).filter((file) => !dirtyAtSpawn.has(file));
  const agentWritten = [...agentWrittenSet];

  const changedFiles = [...new Set([...tracked, ...agentWritten])].slice(
    0,
    MAX_CHANGED_FILES,
  );
  if (changedFiles.length === 0) return undefined;

  // Real stat from git (tracked changes); independent of how much diff text we
  // render. Falls back to a file count for a purely gitignored/untracked set.
  const shortstat = (await git(workdir, ["diff", "--shortstat", base]))?.trim();
  const diffStat =
    shortstat && shortstat.length > 0
      ? shortstat
      : `${changedFiles.length} file(s) changed`;

  let diff = "";
  for (const file of changedFiles.slice(0, MAX_FILE_DIFFS)) {
    const fd = await fileDiff(workdir, base, file);
    if (fd) diff = diff ? `${diff}\n${fd}` : fd;
    if (diff.length > MAX_DIFF_CHARS) break;
  }
  const overLength = diff.length > MAX_DIFF_CHARS;
  if (overLength) diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n… [diff truncated]`;

  return {
    changedFiles,
    diffStat,
    diff,
    truncated: overLength || changedFiles.length >= MAX_CHANGED_FILES,
    capturedAt: Date.now(),
  };
}

/** One-line, human-facing summary of a change set for a completion banner. */
export function summarizeChangeSet(changeSet: WorkspaceChangeSet): string {
  const count = changeSet.changedFiles.length;
  const noun = count === 1 ? "file" : "files";
  const shown = changeSet.changedFiles.slice(0, 6).join(", ");
  const more = count > 6 ? ` (+${count - 6} more)` : "";
  return `Changed ${count} ${noun}: ${shown}${more}`;
}
