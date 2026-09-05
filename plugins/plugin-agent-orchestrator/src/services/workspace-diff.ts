/**
 * Computes the real git changeset for a coding session's workspace: captures a
 * baseline SHA and dirty state at spawn, then renders the complete diff and
 * changed-file list that back the `CODING_SESSION_CHANGES` provider's answers to
 * "show me the diff" queries. An unborn HEAD (a fresh repo with zero commits) is diffed against
 * the canonical empty-tree hash so the whole working tree reads as added.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { ElizaError } from "@elizaos/core";

const GIT_TIMEOUT_MS = 10_000;

// The canonical git empty-tree object hash. On an unborn HEAD (a fresh repo
// with zero commits), `git diff HEAD` throws because HEAD resolves to nothing;
// diffing against the empty tree yields the whole working tree as "added"
// instead (issue elizaOS/eliza#11578 FIX C).
const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

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
  /** Exact per-file patch ownership; absent on older persisted captures. */
  fileDiffs?: Array<{ path: string; diff: string }>;
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

interface GitResult {
  stdout: string;
  stderr: string;
  status: number;
}

async function gitResult(workdir: string, args: string[]): Promise<GitResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C" };
  // Capture owns selector semantics; inherited Git modes must not reinterpret
  // literal names or disable the explicit exclusion of descendant paths.
  delete env.GIT_LITERAL_PATHSPECS;
  delete env.GIT_GLOB_PATHSPECS;
  delete env.GIT_NOGLOB_PATHSPECS;
  delete env.GIT_ICASE_PATHSPECS;
  return new Promise((resolveResult, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const child = spawn("git", args, {
      cwd: workdir,
      env,
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const fail = (cause: Error) =>
      reject(
        new ElizaError("Unable to read complete workspace Git output", {
          code: "WORKSPACE_GIT_CAPTURE_FAILED",
          cause,
          context: { workdir, args },
        }),
      );
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdout.on("error", fail);
    child.stderr.on("error", fail);
    child.on("error", fail);
    // `close` follows stream completion; a signal or transport error must never
    // promote the bytes received before failure into complete evidence.
    child.on("close", (status, signal) => {
      if (status === null || signal !== null) {
        fail(new Error(`Git terminated by ${signal ?? "an unknown failure"}`));
        return;
      }
      resolveResult({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        status,
      });
    });
  });
}

function requireGitSuccess(
  result: GitResult,
  workdir: string,
  args: string[],
): string {
  if (result.status !== 0) {
    throw new ElizaError("Workspace Git command failed", {
      code: "WORKSPACE_GIT_COMMAND_FAILED",
      context: { workdir, args, status: result.status, stderr: result.stderr },
    });
  }
  return result.stdout;
}

async function git(workdir: string, args: string[]): Promise<string> {
  return requireGitSuccess(await gitResult(workdir, args), workdir, args);
}

async function isWorkTree(workdir: string): Promise<boolean> {
  const args = ["rev-parse", "--is-inside-work-tree"];
  const result = await gitResult(workdir, args);
  if (
    result.status === 128 &&
    result.stderr.startsWith("fatal: not a git repository")
  ) {
    return false;
  }
  return requireGitSuccess(result, workdir, args).trim() === "true";
}

async function headSha(workdir: string): Promise<string | undefined> {
  const args = ["rev-parse", "--verify", "--quiet", "HEAD"];
  const result = await gitResult(workdir, args);
  if (result.status === 1 && result.stdout === "" && result.stderr === "") {
    return undefined;
  }
  return requireGitSuccess(result, workdir, args).trim();
}

/** Returns the checked-out branch for resume metadata, or undefined outside a named branch. */
export async function getWorkspaceBranch(
  workdir: string,
): Promise<string | undefined> {
  if (!(await isWorkTree(workdir))) return undefined;
  const branch = (await git(workdir, ["branch", "--show-current"])).trim();
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
  return headSha(workdir);
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
  const base = (await headSha(workdir)) ?? EMPTY_TREE_HASH;
  return parseNullRecords(
    await git(workdir, ["diff", "--name-only", "-z", base]),
  );
}

/**
 * Untracked paths already present in the workspace at spawn time, in the same
 * collapsed representation `git status --porcelain` reports them (`dir/` for a
 * wholly-untracked directory). A lived-in workdir (a home-dir cwd, a shared
 * checkout) carries untracked files no sub-agent created; without this
 * baseline the completion-residuals gate counts them as this run's leftover
 * work and blocks every completion there forever.
 */
export async function captureBaselineUntracked(
  workdir: string,
): Promise<string[]> {
  if (!(await isWorkTree(workdir))) return [];
  const records = parseNullRecords(
    await git(workdir, ["status", "--porcelain", "-z"]),
  );
  const files: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.startsWith("?? ")) files.push(record.slice(3));
    // Porcelain -z places the original pathname after a rename/copy record.
    if (/[RC]/.test(record.slice(0, 2))) index += 1;
  }
  return files;
}

/**
 * Parse `git diff --name-status -z`; rename/copy records contain two paths and
 * the destination is the affected path. NUL separators preserve Git filenames.
 */
function parseNameStatus(out: string): string[] {
  const files: string[] = [];
  const records = parseNullRecords(out);
  for (let index = 0; index < records.length; ) {
    const status = records[index++];
    if (/^[RC]/.test(status)) index += 1;
    const file = records[index++];
    if (!file) {
      throw new ElizaError("Incomplete Git filename record", {
        code: "WORKSPACE_GIT_OUTPUT_INVALID",
      });
    }
    files.push(file);
  }
  return files;
}

function parseNullRecords(out: string): string[] {
  if (out === "") return [];
  if (!out.endsWith("\0")) {
    throw new ElizaError("Incomplete Git filename output", {
      code: "WORKSPACE_GIT_OUTPUT_INVALID",
    });
  }
  const records = out.split("\0");
  records.pop();
  return records;
}

/**
 * Parse complete legacy newline-delimited ls-files output. Runtime capture
 * uses NUL records; this exported compatibility parser rejects partial output.
 */
export function parseLsFiles(out: string | undefined): string[] {
  if (!out) return [];
  if (!out.endsWith("\n")) {
    throw new ElizaError("Incomplete Git filename output", {
      code: "WORKSPACE_GIT_OUTPUT_INVALID",
    });
  }
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// Dependency/build directories a fresh scaffold populates BEFORE any
// .gitignore exists (`npm install` typically runs first). On an unborn HEAD
// `--exclude-standard` has no .gitignore to honor, so thousands of vendor
// paths would swamp the agent's real files. Applies to the unborn-HEAD
// untracked scoop ONLY — the born-HEAD path
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
  return (await headSha(workdir)) ?? EMPTY_TREE_HASH;
}

/** Normalize a tool-call file path to workdir-relative POSIX form. */
function toWorkdirRelative(workdir: string, file: string): string {
  if (!file) return "";
  const absolute = isAbsolute(file) ? file : resolve(workdir, file);
  const rel = relative(workdir, absolute);
  const normalized =
    process.platform === "win32" ? rel.split("\\").join("/") : rel;
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
  trackedFiles: readonly string[],
): Promise<string> {
  const tracked = await git(workdir, [
    "diff",
    base,
    "--",
    `:(literal)${file}`,
    `:(exclude,literal)${file}/`,
  ]);
  if (tracked) return tracked;
  const absolute = resolve(workdir, file);
  // Directory tool targets retain their inventory entry. Descendant patches
  // belong to their exact file entries, including when the directory was deleted.
  if (
    trackedFiles.some((path) => path.startsWith(`${file}/`)) ||
    (existsSync(absolute) && statSync(absolute).isDirectory())
  )
    return "";
  const args = ["diff", "--no-index", "--", "/dev/null", file];
  const created = await gitResult(workdir, args);
  if (created.status === 1) return created.stdout;
  return requireGitSuccess(created, workdir, args);
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
  const allTracked = parseNameStatus(
    await git(workdir, ["diff", "--name-status", "-z", base]),
  );
  const tracked = allTracked.filter((file) => !dirtyAtSpawn.has(file));
  const agentWritten = [...agentWrittenSet];

  // On an unborn HEAD only: include untracked files so shell-driven creates
  // (mkdir/cp/redirect) that never went through the edit/write tool path still
  // surface. `git diff <empty-tree>` sees only files git already knows about,
  // so a freshly scaffolded, never-added file would otherwise be invisible
  // (issue #11578 FIX C). Scoped to unborn HEAD to preserve the born-HEAD
  // clutter invariant above.
  const untracked = unbornHead
    ? parseNullRecords(
        await git(workdir, [
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
        ]),
      ).filter((file) => !dirtyAtSpawn.has(file) && !isVendorScoopPath(file))
    : [];

  // Agent-written paths FIRST: explicit edit/write tool calls are the
  // highest-signal entries. Set dedupe keeps first-occurrence order.
  const changedFiles = [
    ...new Set([...agentWritten, ...tracked, ...untracked]),
  ];
  if (changedFiles.length === 0) return undefined;

  const fileDiffs: Array<{ path: string; diff: string }> = [];
  for (const file of changedFiles) {
    const fd = await fileDiff(workdir, base, file, allTracked);
    fileDiffs.push({ path: file, diff: fd });
  }

  return {
    changedFiles,
    diffStat: summarizeChangeSetFiles(changedFiles),
    diff: joinFileDiffs(fileDiffs),
    fileDiffs,
    truncated: false,
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
  ];
  if (changedFiles.length === 0) return undefined;

  const fileDiffs: Array<{ path: string; diff: string }> = [];
  for (const file of changedFiles) {
    const absolute = resolve(workdir, file);
    let fileDiff = "";
    try {
      if (existsSync(absolute)) {
        const stat = statSync(absolute);
        if (stat.isFile()) {
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
    fileDiffs.push({ path: file, diff: fileDiff });
  }

  return {
    changedFiles,
    diffStat: summarizeChangeSetFiles(changedFiles),
    diff: joinFileDiffs(fileDiffs),
    fileDiffs,
    truncated: false,
    capturedAt: Date.now(),
  };
}

/**
 * Complete diff + changed-file list for a workspace branch against its PR base.
 *
 * The gate needs the full diff text to scan every added line. We diff
 * `base...HEAD` (three-dot = changes on the branch since it forked
 * from base) so pre-existing base-branch content is never re-scanned, and fall
 * back to a two-dot `base HEAD` diff when the merge-base can't be resolved (e.g.
 * unrelated histories). Non-repository workspaces are unavailable; command
 * failures throw so the caller cannot review an incomplete changeset.
 */
export interface PrGateChangeSet {
  changedFiles: string[];
  diff: string;
  /** True when the diff text was truncated at the gate budget. */
  truncated: boolean;
  /** True when the changed-file list was truncated at the gate budget. */
  filesTruncated: boolean;
}

export async function capturePrGateChangeSet(
  workdir: string,
  baseBranch: string,
): Promise<PrGateChangeSet | undefined> {
  if (!(await isWorkTree(workdir))) return undefined;
  const base = (baseBranch ?? "").trim();
  if (!base) return undefined;

  // Choose one comparison for both commands. Only unrelated histories permit
  // a direct comparison; an invalid ref or failed process is not a fallback.
  let refs = [`${base}...HEAD`];
  let args = ["diff", "--name-status", "-z", ...refs];
  let names = await gitResult(workdir, args);
  if (names.status === 128 && names.stderr.includes("no merge base")) {
    refs = [base, "HEAD"];
    args = ["diff", "--name-status", "-z", ...refs];
    names = await gitResult(workdir, args);
  }
  const changedFiles = parseNameStatus(requireGitSuccess(names, workdir, args));
  const diffRaw = await git(workdir, ["diff", ...refs]);
  return {
    changedFiles,
    diff: diffRaw,
    truncated: false,
    filesTruncated: false,
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
  const shown = changeSet.changedFiles.join(", ");
  const verifiedSuffix = verification
    ? verification.verified
      ? " (verified on disk)"
      : ` (UNVERIFIED: missing ${verification.missingFiles.join(", ")})`
    : "";
  return `Changed ${count} ${noun}: ${shown}${verifiedSuffix}`;
}

/** Describe the same retained inventory as the patch, without reinterpreting paths through Git selectors. */
function summarizeChangeSetFiles(files: readonly string[]): string {
  return `${files.length} ${files.length === 1 ? "file" : "files"} changed: ${files.map((path) => JSON.stringify(path)).join(", ")}`;
}

function joinFileDiffs(
  fileDiffs: Array<{ path: string; diff: string }>,
): string {
  return fileDiffs
    .map((entry) => entry.diff)
    .filter(Boolean)
    .join("\n");
}

function invalidPatchOwnership(): ElizaError {
  return new ElizaError(
    "Cannot attribute persisted workspace patches to files; recapture the workspace change set before subtracting its baseline",
    { code: "WORKSPACE_CHANGESET_PATCH_OWNERSHIP_INVALID" },
  );
}

const GIT_PATH_ESCAPES: Record<number, string> = {
  7: "\\a",
  8: "\\b",
  9: "\\t",
  10: "\\n",
  11: "\\v",
  12: "\\f",
  13: "\\r",
  34: '\\"',
  92: "\\\\",
};

/** Git quotes control characters and, with core.quotePath, UTF-8 bytes. */
function quotedGitPath(path: string, quoteUnicode: boolean): string {
  const escaped = [...Buffer.from(path)]
    .map((byte) => {
      return (
        GIT_PATH_ESCAPES[byte] ??
        (byte < 32 || byte === 127 || (quoteUnicode && byte >= 128)
          ? `\\${byte.toString(8).padStart(3, "0")}`
          : String.fromCharCode(byte))
      );
    })
    .join("");
  return `"${Buffer.from(escaped, "latin1").toString("utf8")}"`;
}

function legacyPatchPaths(
  diff: string,
  changedFiles: readonly string[],
): string[] {
  const [header, ...lines] = diff.split("\n");
  const movedTo = lines.find(
    (line) => line.startsWith("rename to ") || line.startsWith("copy to "),
  );
  const encodings = (path: string) =>
    [path, quotedGitPath(path, true), quotedGitPath(path, false)].filter(
      (encoded) => !encoded.includes("\n"),
    );
  return changedFiles.filter((path) => {
    const destinations = encodings(`b/${path}`);
    if (movedTo !== undefined) {
      return (
        encodings(path).some(
          (encoded) =>
            movedTo === `rename to ${encoded}` ||
            movedTo === `copy to ${encoded}`,
        ) && destinations.some((encoded) => header?.endsWith(` ${encoded}`))
      );
    }
    // A suffix alone can attribute "nested b/bar" to "bar" when the saved
    // inventory is incomplete. Ordinary patches must match both full paths.
    return encodings(`a/${path}`).some((source) =>
      destinations.some(
        (destination) => header === `diff --git ${source} ${destination}`,
      ),
    );
  });
}

function readFileDiffs(
  changeSet: WorkspaceChangeSet,
): Array<{ path: string; diff: string }> {
  if (changeSet.fileDiffs !== undefined) {
    const entries = changeSet.fileDiffs;
    if (
      !Array.isArray(entries) ||
      entries.some(
        (entry) =>
          !entry ||
          typeof entry.path !== "string" ||
          typeof entry.diff !== "string",
      )
    ) {
      throw invalidPatchOwnership();
    }
    const paths = new Set(entries.map((entry) => entry.path));
    if (
      paths.size !== entries.length ||
      paths.size !== changeSet.changedFiles.length ||
      changeSet.changedFiles.some((path) => !paths.has(path)) ||
      joinFileDiffs(entries) !== changeSet.diff
    )
      throw invalidPatchOwnership();
    return entries;
  }

  // Older persisted captures have only Git's display text. Match against the
  // authoritative file inventory; never guess an ambiguous suffix or retain
  // an unowned patch as if subtraction had succeeded.
  const patches = new Map<string, string[]>();
  for (const diff of changeSet.diff
    .split(/^(?=diff --git )/m)
    .filter(Boolean)) {
    const paths = legacyPatchPaths(diff, changeSet.changedFiles);
    if (paths.length !== 1) throw invalidPatchOwnership();
    const path = paths[0];
    if (path === undefined) throw invalidPatchOwnership();
    const previous = patches.get(path) ?? [];
    previous.push(diff);
    patches.set(path, previous);
  }
  return changeSet.changedFiles.map((path) => ({
    path,
    diff: (patches.get(path) ?? []).join("\n"),
  }));
}

/** Remove exact spawn-time baseline paths and their patches from completion evidence. */
export function subtractChangeSetBaseline(
  changeSet: WorkspaceChangeSet,
  baselinePaths: readonly string[],
): WorkspaceChangeSet {
  const baseline = new Set(baselinePaths);
  const changedFiles = changeSet.changedFiles.filter(
    (file) => !baseline.has(file),
  );
  if (changedFiles.length === changeSet.changedFiles.length) return changeSet;

  const fileDiffs = readFileDiffs(changeSet).filter(
    (entry) => !baseline.has(entry.path),
  );
  return {
    ...changeSet,
    changedFiles,
    diff: joinFileDiffs(fileDiffs),
    diffStat: summarizeChangeSetFiles(changedFiles),
    fileDiffs,
  };
}
