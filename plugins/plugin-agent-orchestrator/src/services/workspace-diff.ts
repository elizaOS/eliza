/**
 * Computes the real git changeset for a coding session's workspace: captures a
 * baseline SHA and dirty state at spawn, then renders the bounded diff and
 * changed-file list that back the `CODING_SESSION_CHANGES` provider's answers to
 * "show me the diff" queries. Output is capped by file count and character
 * budget, and an unborn HEAD (a fresh repo with zero commits) is diffed against
 * the canonical empty-tree hash so the whole working tree reads as added.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const MAX_DIFF_CHARS = 6_000;
const MAX_CHANGED_FILES = 60;
const MAX_FILE_DIFFS = 12;

// The canonical git empty-tree object hash. On an unborn HEAD (a fresh repo
// with zero commits), `git diff HEAD` throws because HEAD resolves to nothing;
// diffing against the empty tree yields the whole working tree as "added"
// instead (issue elizaOS/eliza#11578 FIX C).
const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

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

/** Disk-level verification for one path the sub-agent claims changed. */
export interface WorkspaceChangedFileVerification {
  path: string;
  absolutePath: string;
  exists: boolean;
  sizeBytes?: number;
  kind?: "file" | "directory" | "other";
  error?: string;
}

/** Completion-time artifact verification rooted in the real session workdir. */
export interface WorkspaceArtifactVerification {
  workdir: string;
  verified: boolean;
  files: WorkspaceChangedFileVerification[];
  missingFiles: string[];
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

/**
 * Parse `git ls-files --others` output (one path per line) into a path list.
 * A complete listing always ends with a newline; when the output was cut at
 * maxBuffer (ENOBUFS on a huge untracked tree) the tail is a truncated
 * garbage path — drop the partial final line rather than surface junk.
 */
export function parseLsFiles(out: string | undefined): string[] {
  if (!out) return [];
  const complete = out.endsWith("\n")
    ? out
    : out.slice(0, out.lastIndexOf("\n") + 1);
  return complete
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// Dependency/build directories a fresh scaffold populates BEFORE any
// .gitignore exists (`npm install` typically runs first). On an unborn HEAD
// `--exclude-standard` has no .gitignore to honor, so thousands of vendor
// paths would flood MAX_CHANGED_FILES and evict the agent's real files.
// Fallback for the unborn-HEAD untracked scoop ONLY — the born-HEAD path
// never scoops untracked files, and explicit tool-written paths are always
// kept regardless (agentWritten is unioned separately).
const UNBORN_SCOOP_VENDOR_DIRS = new Set([
  "node_modules",
  ".git",
  ".yarn",
  ".pnpm-store",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".turbo",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "coverage",
  "vendor",
  "target",
]);

function isVendorScoopPath(path: string): boolean {
  return path
    .split("/")
    .some((segment) => UNBORN_SCOOP_VENDOR_DIRS.has(segment));
}

/**
 * Resolve the base ref for the completion diff. Prefers the captured baseline
 * sha; otherwise HEAD — but when HEAD is unborn (a fresh repo with zero commits)
 * `git rev-parse --verify HEAD` fails, so we fall back to the empty-tree hash so
 * the diff still sees the entire working tree as added (issue #11578 FIX C).
 */
async function resolveDiffBase(
  workdir: string,
  baselineSha?: string,
): Promise<string> {
  const trimmed = baselineSha?.trim();
  if (trimmed) return trimmed;
  const head = await git(workdir, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  return head?.trim() ? "HEAD" : EMPTY_TREE_HASH;
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
  if (!(await isWorkTree(workdir))) {
    return captureToolPathOnlyChangeSet(workdir, toolPaths);
  }
  // Resolve the diff base. When no explicit baseline sha was captured we use
  // HEAD — but on an unborn HEAD (zero commits) `git diff HEAD` throws and the
  // caller previously fell back to the weak narration path (issue #11578
  // round-1/2). Substitute the empty-tree hash so a fresh repo still surfaces
  // its whole working tree as a change set.
  const base = await resolveDiffBase(workdir, baselineSha);
  // `base === EMPTY_TREE_HASH` iff HEAD was unborn (a FRESH repo, no baseline).
  // That is the only case where we merge `git ls-files --others`: a fresh repo
  // has no accumulated prior-session clutter, so surfacing every untracked file
  // is correct. In the normal born-HEAD case we deliberately DO NOT scoop up
  // untracked files (that would regress the shared-workspace clutter invariant
  // pinned by the workspace-diff tests) — tracked diff + tool paths stay scoped
  // to this session.
  const unbornHead = base === EMPTY_TREE_HASH;

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

  // On an unborn HEAD only: include untracked files so shell-driven creates
  // (mkdir/cp/redirect) that never went through the edit/write tool path still
  // surface. `git diff <empty-tree>` sees only files git already knows about,
  // so a freshly scaffolded, never-added file would otherwise be invisible
  // (issue #11578 FIX C). Scoped to unborn HEAD to preserve the born-HEAD
  // clutter invariant above.
  const untracked = unbornHead
    ? parseLsFiles(
        await git(workdir, ["ls-files", "--others", "--exclude-standard"]),
      ).filter((file) => !dirtyAtSpawn.has(file) && !isVendorScoopPath(file))
    : [];

  // Agent-written paths FIRST: explicit edit/write tool calls are the
  // highest-signal entries and must survive the MAX_CHANGED_FILES cap when a
  // large scaffold floods `untracked`. Set dedupe keeps first-occurrence
  // order, so spreading them last let the flood evict them entirely.
  const changedFiles = [
    ...new Set([...agentWritten, ...tracked, ...untracked]),
  ].slice(0, MAX_CHANGED_FILES);
  if (changedFiles.length === 0) return undefined;

  // Real stat from git for the same filtered file set rendered to the user.
  // This avoids counting files that were already dirty at spawn and excluded
  // from `changedFiles`. Falls back to a file count for gitignored/untracked
  // tool-written files.
  const shortstat = (
    await git(workdir, ["diff", "--shortstat", base, "--", ...changedFiles])
  )?.trim();
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

function captureToolPathOnlyChangeSet(
  workdir: string,
  toolPaths: string[],
): WorkspaceChangeSet | undefined {
  const changedFiles = [
    ...new Set(
      toolPaths
        .map((file) => toWorkdirRelative(workdir, file))
        .filter((file) => file.length > 0),
    ),
  ].slice(0, MAX_CHANGED_FILES);
  if (changedFiles.length === 0) return undefined;

  let diff = "";
  for (const file of changedFiles.slice(0, MAX_FILE_DIFFS)) {
    const absolute = resolve(workdir, file);
    let fileDiff = "";
    try {
      if (existsSync(absolute)) {
        const stat = statSync(absolute);
        if (stat.isFile() && stat.size <= MAX_DIFF_CHARS) {
          const content = readFileSync(absolute, "utf8");
          fileDiff = [
            `diff --git a/${file} b/${file}`,
            "new file mode 100644",
            "--- /dev/null",
            `+++ b/${file}`,
            "@@",
            ...content.split("\n").map((line) => `+${line}`),
          ].join("\n");
        }
      }
    } catch {
      // error-policy:J4 unreadable file → omit from diff preview; still listed in changedFiles
      fileDiff = "";
    }
    if (fileDiff) diff = diff ? `${diff}\n${fileDiff}` : fileDiff;
    if (diff.length > MAX_DIFF_CHARS) break;
  }

  const overLength = diff.length > MAX_DIFF_CHARS;
  if (overLength) diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n… [diff truncated]`;

  return {
    changedFiles,
    diffStat: `${changedFiles.length} file(s) changed`,
    diff,
    truncated: overLength || changedFiles.length >= MAX_CHANGED_FILES,
    capturedAt: Date.now(),
  };
}

export function verifyChangedFilesOnDisk(
  workdir: string,
  changedFiles: readonly string[],
): WorkspaceArtifactVerification {
  const files = changedFiles.map((file) => {
    const rel = toWorkdirRelative(workdir, file) || file;
    const absolutePath = resolve(workdir, rel);
    try {
      const stat = statSync(absolutePath);
      return {
        path: rel,
        absolutePath,
        exists: true,
        sizeBytes: stat.size,
        kind: stat.isFile()
          ? ("file" as const)
          : stat.isDirectory()
            ? ("directory" as const)
            : ("other" as const),
      };
    } catch (err) {
      // error-policy:J3 stat probe failure → explicit exists:false result with error; surfaced via missingFiles
      return {
        path: rel,
        absolutePath,
        exists: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
  const missingFiles = files
    .filter((file) => !file.exists)
    .map((file) => file.path);
  return {
    workdir,
    verified: missingFiles.length === 0,
    files,
    missingFiles,
  };
}

/** One-line, human-facing summary of a change set for a completion banner. */
export function summarizeChangeSet(
  changeSet: WorkspaceChangeSet,
  verification?: WorkspaceArtifactVerification,
): string {
  const count = changeSet.changedFiles.length;
  const noun = count === 1 ? "file" : "files";
  const shown = changeSet.changedFiles.slice(0, 6).join(", ");
  const more = count > 6 ? ` (+${count - 6} more)` : "";
  const verifiedSuffix = verification
    ? verification.verified
      ? " (verified on disk)"
      : ` (UNVERIFIED: missing ${verification.missingFiles.join(", ")})`
    : "";
  return `Changed ${count} ${noun}: ${shown}${more}${verifiedSuffix}`;
}
