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
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_CHARS = 6_000;
const MAX_CHANGED_FILES = 60;
const MAX_FILE_DIFFS = 12;

// The canonical git empty-tree object hash. On an unborn HEAD (a fresh repo
// with zero commits), `git diff HEAD` throws because HEAD resolves to nothing;
// diffing against the empty tree yields the whole working tree as "added"
// instead (issue elizaOS/eliza#11578 FIX C).
const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface WorkspaceGitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface WorkspaceStatusEntry {
  display: string;
  paths: string[];
}

/** Parses porcelain-v1 `-z` output without Git's path quoting ambiguity. */
export function parseWorkspaceStatus(output: string): WorkspaceStatusEntry[] {
  const records = output.split("\0");
  const entries: WorkspaceStatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    const firstPath = record.slice(3);
    if (status.includes("R") || status.includes("C")) {
      const secondPath = records[index + 1];
      if (!secondPath) continue;
      index += 1;
      entries.push({
        display: `${status} ${secondPath} -> ${firstPath}`,
        paths: [secondPath, firstPath],
      });
      continue;
    }
    entries.push({ display: `${status} ${firstPath}`, paths: [firstPath] });
  }
  return entries;
}

/** Git subprocess boundary with file-backed output to avoid pipe buffer limits. */
export async function runWorkspaceGit(
  workdir: string,
  args: string[],
  envPatch?: Record<string, string>,
): Promise<WorkspaceGitResult> {
  const outputDir = mkdtempSync(join(tmpdir(), "workspace-git-"));
  const stdoutPath = join(outputDir, "stdout");
  const stderrPath = join(outputDir, "stderr");
  writeFileSync(stdoutPath, "");
  writeFileSync(stderrPath, "");
  try {
    const stdoutFd = openSync(stdoutPath, "w");
    const stderrFd = openSync(stderrPath, "w");
    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawnSync("git", args, {
        cwd: workdir,
        env: { ...process.env, ...envPatch },
        stdio: ["ignore", stdoutFd, stderrFd],
        timeout: GIT_TIMEOUT_MS,
      });
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
    if (result.error) {
      return {
        ok: false,
        stdout: "",
        stderr: result.error.message,
      };
    }
    if (
      statSync(stdoutPath).size > GIT_MAX_OUTPUT_BYTES ||
      statSync(stderrPath).size > GIT_MAX_OUTPUT_BYTES
    ) {
      return {
        ok: false,
        stdout: "",
        stderr: `git output exceeded ${GIT_MAX_OUTPUT_BYTES} bytes`,
      };
    }
    const stdout = readFileSync(stdoutPath, "utf8");
    const stderr = readFileSync(stderrPath, "utf8");
    return {
      ok: result.status === 0,
      stdout,
      stderr,
    };
  } catch (error) {
    // error-policy:J3 process-spawn failure is an explicit failed probe.
    return {
      ok: false,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
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
  envPatch?: Record<string, string>,
): Promise<string | undefined> {
  const result = await runWorkspaceGit(workdir, args, envPatch);
  // `git diff --no-index` exits 1 when files differ; non-empty stdout is still
  // the useful result for that command.
  if (result.ok || result.stdout.length > 0) return result.stdout;
  return undefined;
}

async function isWorkTree(workdir: string): Promise<boolean> {
  const inside = await git(workdir, ["rev-parse", "--is-inside-work-tree"]);
  return inside?.trim() === "true";
}

/** Returns the checked-out branch for resume metadata, or undefined outside a named branch. */
export async function getWorkspaceBranch(
  workdir: string,
): Promise<string | undefined> {
  if (!(await isWorkTree(workdir))) return undefined;
  const branch = (await git(workdir, ["branch", "--show-current"]))?.trim();
  return branch || undefined;
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

/** Every tracked, staged, deleted, renamed, and untracked path dirty at spawn. */
export async function captureWorkspaceDirtyPaths(
  workdir: string,
): Promise<string[] | undefined> {
  if (!(await isWorkTree(workdir))) return undefined;
  const status = await runWorkspaceGit(workdir, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (!status.ok) return undefined;
  return [
    ...new Set(
      parseWorkspaceStatus(status.stdout).flatMap((entry) => entry.paths),
    ),
  ];
}

/**
 * Writes the current non-ignored workspace state to an unreachable git tree
 * through a temporary index. The real index and working files are untouched;
 * callers can later distinguish unchanged pre-existing churn from edits made
 * during a session.
 */
export async function captureWorkspaceTreeSha(
  workdir: string,
): Promise<string | undefined> {
  if (!(await isWorkTree(workdir))) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "workspace-tree-"));
  const indexFile = join(dir, "index");
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    const readTree = await runWorkspaceGit(
      workdir,
      ["read-tree", "--empty"],
      env,
    );
    if (!readTree.ok) return undefined;
    const add = await runWorkspaceGit(workdir, ["add", "-A", "--", "."], env);
    if (!add.ok) return undefined;
    const tree = await runWorkspaceGit(workdir, ["write-tree"], env);
    return tree.ok ? tree.stdout.trim() || undefined : undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

/**
 * Diff + changed-file list for a workspace BRANCH against its PR base, sized for
 * the diff-review gate (not the small user-facing "show me the diff" preview).
 *
 * The gate needs the FULL diff text to scan every added line for secrets, so the
 * character budget here is far larger than {@link captureChangeSet}'s 6k preview
 * cap. We diff `base...HEAD` (three-dot = changes on the branch since it forked
 * from base) so pre-existing base-branch content is never re-scanned, and fall
 * back to a two-dot `base HEAD` diff when the merge-base can't be resolved (e.g.
 * unrelated histories). Best-effort: any git failure yields `undefined` and the
 * caller treats the gate as unavailable rather than blocking a legitimate PR.
 */
export interface PrGateChangeSet {
  changedFiles: string[];
  diff: string;
  /** True when the diff text was truncated at the gate budget. */
  truncated: boolean;
  /** True when the changed-file list was truncated at the gate budget. */
  filesTruncated: boolean;
}

const GATE_MAX_DIFF_CHARS = 2_000_000;
const GATE_MAX_CHANGED_FILES = 5_000;

export async function capturePrGateChangeSet(
  workdir: string,
  baseBranch: string,
): Promise<PrGateChangeSet | undefined> {
  if (!(await isWorkTree(workdir))) return undefined;
  const base = (baseBranch ?? "").trim();
  if (!base) return undefined;

  // Prefer the branch-since-fork diff (base...HEAD). If the symmetric range
  // can't resolve (no common ancestor), fall back to the direct base..HEAD diff.
  const nameStatus =
    (await git(workdir, ["diff", "--name-status", `${base}...HEAD`])) ??
    (await git(workdir, ["diff", "--name-status", base, "HEAD"]));
  if (nameStatus === undefined) return undefined;

  const allChangedFiles = parseNameStatus(nameStatus);
  const filesTruncated = allChangedFiles.length > GATE_MAX_CHANGED_FILES;
  const changedFiles = allChangedFiles.slice(0, GATE_MAX_CHANGED_FILES);

  const diffRaw =
    (await git(workdir, ["diff", `${base}...HEAD`])) ??
    (await git(workdir, ["diff", base, "HEAD"])) ??
    "";
  const truncated = diffRaw.length > GATE_MAX_DIFF_CHARS;
  const diff = truncated ? diffRaw.slice(0, GATE_MAX_DIFF_CHARS) : diffRaw;

  return { changedFiles, diff, truncated, filesTruncated };
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
