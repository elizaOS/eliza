/**
 * Computes the real git changeset for a coding session's workspace: captures a
 * baseline SHA and dirty state at spawn, then renders the complete diff and
 * changed-file list that back the `CODING_SESSION_CHANGES` provider's answers to
 * "show me the diff" queries. An unborn HEAD (a fresh repo with zero commits) is diffed against
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
// Generous read ceiling: a real coding-session diff essentially never reaches
// it, and when one does the cut is DETECTED and reported honestly (the
// prompt-integrity invariant forbids a silent clamp near a model path). The
// env var is a test seam so the truncation detection is provable with small
// buffers; it is read per call, never cached.
const GIT_MAX_BUFFER_DEFAULT = 64 * 1024 * 1024;

function gitMaxBuffer(): number {
  const raw = process.env.WORKSPACE_DIFF_GIT_MAX_BUFFER;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : GIT_MAX_BUFFER_DEFAULT;
}

/**
 * True when a spawnSync result's stdout was cut by the process layer: Node
 * kills the child and flags ENOBUFS when `maxBuffer` overflows, and a
 * buffer-sized read is treated as a short read too (the cut can land exactly
 * on the boundary). Exported for the truncation-honesty regression tests.
 */
export function spawnOutputWasTruncated(
  error: unknown,
  stdoutBytes: number,
  maxBuffer: number,
): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOBUFS" || code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return true;
  }
  return stdoutBytes >= maxBuffer;
}

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

/** One git read plus the honest truncation verdict for it. When `truncated`
 *  is true, `stdout` is a PREFIX of the real output — callers must propagate
 *  that fact instead of presenting the prefix as complete. */
interface GitCapture {
  stdout?: string;
  truncated: boolean;
}

async function gitCapture(
  workdir: string,
  args: string[],
): Promise<GitCapture> {
  const maxBuffer = gitMaxBuffer();
  const direct = spawnSync("git", args, {
    cwd: workdir,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
    windowsHide: true,
  });
  const directStdout = outputToString(direct.stdout);
  const directTruncated = spawnOutputWasTruncated(
    direct.error,
    Buffer.byteLength(directStdout ?? "", "utf8"),
    maxBuffer,
  );
  if (directStdout && directStdout.length > 0) {
    return { stdout: directStdout, truncated: directTruncated };
  }

  // Bun's test runner can report a successful git process with an empty stdout
  // pipe. In that environment only, ask the shell to redirect stdout itself.
  if (direct.status !== 0 && !process.versions.bun) {
    return { stdout: undefined, truncated: directTruncated };
  }
  if (!process.versions.bun) {
    return { stdout: directStdout, truncated: directTruncated };
  }

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
      maxBuffer,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    },
  );

  // `git diff --no-index` exits 1 when files differ — that's the success case
  // for us and the diff is on stdout. Everything else (not a repo, git missing,
  // detached state) is best-effort: change capture must never disturb the
  // session lifecycle. The file redirect receives the full stream (no
  // maxBuffer applies to it), so this path never truncates.
  try {
    const stdout = readFileSync(outPath, "utf8");
    if (result.status === 0 || stdout.length > 0) {
      return { stdout, truncated: false };
    }
    return { stdout: undefined, truncated: false };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

async function git(
  workdir: string,
  args: string[],
): Promise<string | undefined> {
  return (await gitCapture(workdir, args)).stdout;
}

/** Drop the partial final line of a KNOWN-truncated capture (a complete git
 *  listing/diff always ends with a newline) so a cut never surfaces a garbage
 *  half-path. No-op for complete output. */
function completeLines(
  out: string | undefined,
  truncated: boolean,
): string | undefined {
  if (!out || !truncated || out.endsWith("\n")) return out;
  return out.slice(0, out.lastIndexOf("\n") + 1);
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
  return ((await git(workdir, ["status", "--porcelain"])) ?? "")
    .split("\n")
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3).trim())
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

/** Parsed `git ls-files` listing plus the honest cut verdict for it. */
export interface LsFilesListing {
  files: string[];
  /** True when the listing did not end where git ended it: the partial final
   *  line of a maxBuffer-cut read was dropped, and everything after the cut
   *  is absent. Callers MUST surface this — a cut listing presented as
   *  complete silently hides files the agent actually created. */
  truncated: boolean;
}

/**
 * Parse `git ls-files --others` output (one path per line) into a path list.
 * A complete listing always ends with a newline; when the output was cut at
 * maxBuffer (ENOBUFS on a huge untracked tree) the tail is a truncated
 * garbage path — drop the partial final line rather than surface junk, and
 * REPORT the cut so the caller can mark the change set truncated instead of
 * persisting the partial listing as if complete.
 */
export function parseLsFiles(out: string | undefined): LsFilesListing {
  if (!out) return { files: [], truncated: false };
  const truncated = !out.endsWith("\n");
  const complete = truncated ? out.slice(0, out.lastIndexOf("\n") + 1) : out;
  return {
    files: complete
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    truncated,
  };
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

/** Unified diff for one file: real git diff if tracked, else new-file diff.
 *  Carries the read-buffer truncation verdict so the change set can report
 *  a cut diff honestly instead of stamping it complete. */
async function fileDiff(
  workdir: string,
  base: string,
  file: string,
): Promise<{ text: string; truncated: boolean }> {
  const tracked = await gitCapture(workdir, ["diff", base, "--", file]);
  const trackedText = tracked.stdout?.trim();
  if (trackedText) return { text: trackedText, truncated: tracked.truncated };
  const created = await gitCapture(workdir, [
    "diff",
    "--no-index",
    "--",
    "/dev/null",
    file,
  ]);
  return {
    text: created.stdout?.trim() ?? "",
    truncated: tracked.truncated || created.truncated,
  };
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
  // Honest truncation accounting: every git read below can be cut by the
  // process read buffer, and a cut MUST surface as `truncated: true` on the
  // change set — the prompt-integrity invariant forbids persisting a partial
  // capture stamped complete (it flows to the judge, the provider, and the
  // completion evidence as "the real change set").
  let captureTruncated = false;
  const nameStatusCapture = await gitCapture(workdir, [
    "diff",
    "--name-status",
    base,
  ]);
  captureTruncated ||= nameStatusCapture.truncated;
  const tracked = parseNameStatus(
    completeLines(nameStatusCapture.stdout, nameStatusCapture.truncated),
  ).filter((file) => !dirtyAtSpawn.has(file));
  const agentWritten = [...agentWrittenSet];

  // On an unborn HEAD only: include untracked files so shell-driven creates
  // (mkdir/cp/redirect) that never went through the edit/write tool path still
  // surface. `git diff <empty-tree>` sees only files git already knows about,
  // so a freshly scaffolded, never-added file would otherwise be invisible
  // (issue #11578 FIX C). Scoped to unborn HEAD to preserve the born-HEAD
  // clutter invariant above.
  let untracked: string[] = [];
  if (unbornHead) {
    const lsCapture = await gitCapture(workdir, [
      "ls-files",
      "--others",
      "--exclude-standard",
    ]);
    const listing = parseLsFiles(lsCapture.stdout);
    captureTruncated ||= lsCapture.truncated || listing.truncated;
    untracked = listing.files.filter(
      (file) => !dirtyAtSpawn.has(file) && !isVendorScoopPath(file),
    );
  }

  // Agent-written paths FIRST: explicit edit/write tool calls are the
  // highest-signal entries. Set dedupe keeps first-occurrence order.
  const changedFiles = [
    ...new Set([...agentWritten, ...tracked, ...untracked]),
  ];
  if (changedFiles.length === 0) return undefined;

  // Real stat from git for the same filtered file set rendered to the user.
  // This avoids counting files that were already dirty at spawn and excluded
  // from `changedFiles`. Falls back to a file count for gitignored/untracked
  // tool-written files.
  const shortstatCapture = await gitCapture(workdir, [
    "diff",
    "--shortstat",
    base,
    "--",
    ...changedFiles,
  ]);
  captureTruncated ||= shortstatCapture.truncated;
  const shortstat = shortstatCapture.stdout?.trim();
  const diffStat =
    shortstat && shortstat.length > 0
      ? shortstat
      : `${changedFiles.length} file(s) changed`;

  let diff = "";
  for (const file of changedFiles) {
    const fd = await fileDiff(workdir, base, file);
    captureTruncated ||= fd.truncated;
    if (fd.text) diff = diff ? `${diff}\n${fd.text}` : fd.text;
  }

  return {
    changedFiles,
    diffStat,
    diff,
    // Honest verdict: true iff any contributing git read was cut. Consumers
    // (renderChangeSetBody, the CODING_SESSION_CHANGES provider, the PR gate)
    // disclose the cut and carry a durable continuation instead of
    // re-presenting the partial capture as complete.
    truncated: captureTruncated,
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

  let diff = "";
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
    if (fileDiff) diff = diff ? `${diff}\n${fileDiff}` : fileDiff;
  }

  return {
    changedFiles,
    diffStat: `${changedFiles.length} file(s) changed`,
    diff,
    truncated: false,
    capturedAt: Date.now(),
  };
}

/**
 * Complete diff + changed-file list for a workspace branch against its PR base.
 *
 * The gate needs the FULL diff text to scan every added line for secrets, so the
 * We diff `base...HEAD` (three-dot = changes on the branch since it forked
 * from base) so pre-existing base-branch content is never re-scanned, and fall
 * back to a two-dot `base HEAD` diff when the merge-base can't be resolved (e.g.
 * unrelated histories). Best-effort: any git failure yields `undefined` and the
 * caller treats the gate as unavailable rather than blocking a legitimate PR.
 */
export interface PrGateChangeSet {
  changedFiles: string[];
  diff: string;
  /** True when the diff text was cut by the git read buffer. The secret-scan
   *  gate (`reviewDiff`) fails CLOSED on this flag with a typed
   *  `truncated-diff` BLOCK finding — a partial scan can never pass as a
   *  clean one (prompt-integrity: typed pre-dispatch rejection, not a silent
   *  clamp). */
  truncated: boolean;
  /** True when the changed-file list was cut by the git read buffer; the gate
   *  blocks with a typed `truncated-files` finding. */
  filesTruncated: boolean;
}

export async function capturePrGateChangeSet(
  workdir: string,
  baseBranch: string,
): Promise<PrGateChangeSet | undefined> {
  if (!(await isWorkTree(workdir))) return undefined;
  const base = (baseBranch ?? "").trim();
  if (!base) return undefined;

  // Prefer the branch-since-fork diff (base...HEAD). If the symmetric range
  // can't resolve (no common ancestor), fall back to the direct base..HEAD diff.
  const nameStatusThreeDot = await gitCapture(workdir, [
    "diff",
    "--name-status",
    `${base}...HEAD`,
  ]);
  const nameStatusFallback =
    nameStatusThreeDot.stdout === undefined
      ? await gitCapture(workdir, ["diff", "--name-status", base, "HEAD"])
      : undefined;
  const nameStatus = nameStatusThreeDot.stdout ?? nameStatusFallback?.stdout;
  if (nameStatus === undefined) return undefined;
  const filesTruncated =
    nameStatusThreeDot.stdout !== undefined
      ? nameStatusThreeDot.truncated
      : (nameStatusFallback?.truncated ?? false);

  const changedFiles = parseNameStatus(
    completeLines(nameStatus, filesTruncated),
  );

  const diffThreeDot = await gitCapture(workdir, ["diff", `${base}...HEAD`]);
  const diffFallback =
    diffThreeDot.stdout === undefined
      ? await gitCapture(workdir, ["diff", base, "HEAD"])
      : undefined;
  const diffRaw = diffThreeDot.stdout ?? diffFallback?.stdout ?? "";
  const truncated =
    diffThreeDot.stdout !== undefined
      ? diffThreeDot.truncated
      : (diffFallback?.truncated ?? false);
  // HONEST flags, never decorative: a buffer-cut read reports truncated and
  // reviewDiff then fails closed (typed `truncated-diff`/`truncated-files`
  // BLOCK findings) instead of passing a secret scan on unproven completeness.
  return {
    changedFiles,
    diff: diffRaw,
    truncated,
    filesTruncated,
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

/**
 * Remove spawn-time baseline paths from a captured change set. In a SHARED
 * route workdir the git diff sees every pre-existing dirty file from other
 * apps (months-old edits included), so the completion evidence attributed
 * unrelated changes to the session (live: velvet-moth's changeset rendered a
 * different app's diff and the judge called the evidence contradictory). The
 * baselines are the orchestrator-stamped codingBaselineDirty/Untracked lists
 * (#20969's residuals inputs) — subtracting them leaves the session's OWN
 * work. Diff hunks and diffstat lines for baseline paths are dropped with the
 * file list so the rendered body matches.
 */
export function subtractChangeSetBaseline(
  changeSet: WorkspaceChangeSet,
  baselinePaths: readonly string[],
): WorkspaceChangeSet {
  if (baselinePaths.length === 0) return changeSet;
  const baseline = new Set(baselinePaths.map((p) => p.trim()).filter(Boolean));
  if (baseline.size === 0) return changeSet;
  const changedFiles = changeSet.changedFiles.filter(
    (file) => !baseline.has(file),
  );
  if (changedFiles.length === changeSet.changedFiles.length) return changeSet;

  const keptHunks = changeSet.diff
    .split(/^(?=diff --git )/m)
    .filter((hunk) => {
      const match = /^diff --git a\/(\S+) b\//.exec(hunk);
      if (!match) return true;
      return !baseline.has(match[1] ?? "");
    })
    .join("");
  const keptStat = changeSet.diffStat
    .split("\n")
    .filter((line) => {
      const name = line.split("|")[0]?.trim();
      return !name || !baseline.has(name);
    })
    .join("\n");
  return {
    ...changeSet,
    changedFiles,
    diff: keptHunks,
    diffStat: keptStat,
  };
}
