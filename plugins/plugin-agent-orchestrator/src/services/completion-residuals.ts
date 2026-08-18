/**
 * Deterministic completion-residuals check: the machine-verifiable gate a task
 * must clear before `validating` may promote to `done`. Every other verdict in
 * the completion pipeline is judged text (the sub-agent's self-reported
 * envelope, the independent ACP verifier, the TEXT_SMALL judge) — this module
 * is the one leg that asks git directly, so a worker that "reports done" with
 * a dirty tree or unpushed commits is blocked on facts, not prose.
 *
 * Consumed by `OrchestratorTaskService.autoVerifyCompletion` (before any model
 * spend) and `validateTask` (before honoring a `passed: true` verdict; a human
 * override runs it too, recording what was overridden). Fail-closed for
 * repo-declaring tasks: when the task/session names a repo, a missing workdir
 * string, a missing/non-git directory, or a git/fs probe failure yields
 * `unverifiable` — never a silent pass. Tasks WITHOUT a declared repo (every
 * ACP session still gets an acp-scratch workdir, even a voice/Q&A task) probe
 * the workdir opportunistically: a real git worktree runs the git legs, a
 * scratch/non-git dir skips them, and the envelope-reported failing tests
 * always apply. Self-reported `residualRisks` are DISCLOSURE, not defects:
 * they never block promotion (blocking them taught workers to delete the
 * disclosure or burn the attempt cap) — they ride the snapshot as
 * `disclosedRisks` and surface as caveats in the user-facing completion.
 * `ELIZA_ORCHESTRATOR_RESIDUALS_GATE=0` disables the gate (mirrors the
 * `ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY` flag convention).
 */
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import {
  type OrchestratorOwnedArtifact,
  ownedArtifactStillMatches,
} from "./orchestrator-artifact-ownership.js";
import {
  captureWorkspacePathFingerprints,
  sanitizeWorkspacePathFingerprints,
  type WorkspacePathFingerprint,
} from "./workspace-diff.js";

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

/** Cap on the residual path/detail lists so a giant dirty tree cannot bloat
 * the task metadata or the correction prompt. */
export const MAX_RESIDUAL_PATHS = 20;

/** Provenance stamped on validation events produced by this gate. */
export const COMPLETION_RESIDUALS_VERIFIER_NAME = "completion-residuals";

/** Task-metadata key the latest residuals snapshot is persisted under, so the
 * UI and the user-facing summary can show WHAT blocked (or was overridden at)
 * completion. */
export const COMPLETION_RESIDUALS_METADATA_KEY = "completionResiduals";

/**
 * Whether the deterministic residuals gate runs before a task may promote to
 * `done`. Default ON; set `ELIZA_ORCHESTRATOR_RESIDUALS_GATE=0` to disable.
 */
export function residualsGateEnabled(): boolean {
  return process.env.ELIZA_ORCHESTRATOR_RESIDUALS_GATE !== "0";
}

export type CompletionResidualKind =
  | "baseline_integrity_changed"
  | "history_changed"
  | "uncommitted_changes"
  | "unpushed_commits"
  | "failing_tests_reported";

/** One machine-detected reason the completion is not actually finished. */
export interface CompletionResidual {
  kind: CompletionResidualKind;
  detail: string;
  /** Affected paths / commands / risks, capped at {@link MAX_RESIDUAL_PATHS}. */
  items?: string[];
}

/**
 * - `clean` — every applicable leg passed; promotion may proceed.
 * - `residuals` — concrete leftovers were found; promotion must not proceed.
 * - `unverifiable` — the git legs could not run against a claimed workspace
 *   (missing dir, not a git work tree, git probe failure). NOT a pass: a
 *   workspace task whose state cannot be inspected must not promote on faith.
 */
export type CompletionResidualsStatus = "clean" | "residuals" | "unverifiable";

/** Machine-classifiable reason the git legs could not run — lets callers make
 * policy decisions (e.g. `validateTask` accepts a prior clean snapshot ONLY
 * for `missing_dir`, a GC'd workspace) without string-matching prose. */
export type CompletionUnverifiableKind =
  | "no_workdir"
  | "missing_dir"
  | "not_directory"
  | "not_worktree"
  | "probe_failed"
  | "git_failed";

export interface CompletionResidualsResult {
  status: CompletionResidualsStatus;
  residuals: CompletionResidual[];
  /** Why the git legs could not run, when `status` is `unverifiable`. */
  unverifiableReason?: string;
  /** Structured classification of `unverifiableReason`. */
  unverifiableKind?: CompletionUnverifiableKind;
  /** Worker-disclosed residual risks. Non-blocking by design: honest
   * disclosure must never cost the worker a verification attempt, or the
   * incentive inverts and the disclosure disappears. Surfaced to the user as
   * caveats on the relayed completion instead. */
  disclosedRisks?: string[];
  /** Present when the git legs were DELIBERATELY skipped because the session
   * ran in a shared route-mapped checkout whose git state is not attributable
   * to this run. Rides the persisted snapshot so the exemption is auditable,
   * never a silent pass. */
  gitLegsSkipped?: "shared_route_workdir";
  /** Spawn-stamped delivery policy that affected the git legs/correction. */
  gitDeliveryPolicy?: "leave_uncommitted";
  workdir?: string;
  checkedAt: number;
}

/** The envelope-derived legs: self-reported test results and residual risks
 * from a VALID CompletionEnvelope (a malformed/absent envelope contributes
 * nothing here — the envelope gate handles malformed separately). */
export interface CompletionResidualsInput {
  /** The reporting session's workspace. Empty/undefined = no workspace: the
   * git legs are skipped and only the envelope legs apply. */
  workdir?: string;
  /**
   * Whether the task/session declares a git repo (session `repo` or task
   * `boundRepo`). Every ACP session gets SOME workdir (an acp-scratch dir even
   * for a voice/Q&A task), so the workdir alone cannot distinguish "coding
   * task whose repo state must be provable" from "scratch cwd that happens to
   * exist". When true, the git legs are fail-closed: a missing dir, a non-git
   * dir, or a git probe failure is `unverifiable`. When false, the workdir is
   * probed opportunistically: a real git worktree still runs the git legs
   * (dirty/unpushed there are genuine residuals), but a missing/non-git dir
   * skips them (envelope legs still apply) instead of blocking promotion.
   */
  repoExpected: boolean;
  /** Paths already dirty when the reporting session spawned (session metadata
   * `codingBaselineDirty`, captured by `AcpService.spawnSession` as
   * `git diff --name-only HEAD`). A path is exempt only when its spawn-time
   * fingerprint still matches; a later edit/deletion is this run's damage.
   * Tracked modifications only — untracked exemptions come from
   * `baselineUntrackedPaths`. */
  baselineDirtyPaths?: readonly string[];
  /** Git HEAD captured before the child starts. Under `leave_uncommitted`, any
   * different completion-time HEAD is a contract violation even when the
   * repository has no upstream. */
  baselineSha?: string;
  /** Untracked paths already present when the reporting session spawned
   * (session metadata `codingBaselineUntracked`, captured by
   * `AcpService.spawnSession` from `git status --porcelain` `??` lines). A
   * lived-in workdir (a home-dir cwd, a shared checkout) carries untracked
   * files no sub-agent created; without this baseline they read as this run's
   * leftover work and block every completion there forever. Only paths whose
   * fingerprints still match are exempt — a new or mutated file still counts. */
  baselineUntrackedPaths?: readonly string[];
  /** Sanitized SHA-256/type identities for every exemptible baseline path.
   * Missing or malformed fingerprints fail closed: path names alone never
   * prove that pre-existing dirty bytes were preserved. */
  baselinePathFingerprints?: readonly WorkspacePathFingerprint[];
  /** Run-produced paths that may intentionally remain uncommitted. This is a
   * narrow path allowlist, not a whole-worktree bypass: callers populate it
   * only from the session-scoped workspace change set when the spawn
   * carries an orchestrator-stamped `leave_uncommitted` delivery policy. */
  allowedUncommittedPaths?: readonly string[];
  /** Structured user delivery policy stamped by the orchestrator at spawn. */
  gitDeliveryPolicy?: "leave_uncommitted";
  /** True when the session ran in a SHARED, route-mapped app checkout
   * (`TASK_AGENT_WORKDIR_ROUTES`) rather than a task-provisioned workspace.
   * A shared checkout carries dirt and unpushed commits from before the run
   * and from sibling tasks, so its git facts are not attributable to this
   * session; the git legs are skipped (envelope legs still apply). Ignored
   * when `repoExpected` — an explicit repo claim keeps full strictness. */
  sharedRouteWorkdir?: boolean;
  testResults?: ReadonlyArray<{
    command: string;
    exitCode: number;
    summary: string;
  }>;
  residualRisks?: readonly string[];
  /** Files the orchestrator wrote and can verify by content fingerprint. */
  orchestratorOwnedArtifacts?: readonly OrchestratorOwnedArtifact[];
}

/**
 * Render only machine-proven completion facts for the downstream text judge.
 * A clean residual snapshot is already an enforced gate, but without this
 * section the judge has to guess whether spawn-time sentinels and Git history
 * were preserved from the worker's prose. Keep claims conditional on the exact
 * baseline inputs that made those checks meaningful.
 */
export function renderCompletionResidualEvidence(
  result: CompletionResidualsResult,
  input: CompletionResidualsInput,
): string | undefined {
  if (result.status !== "clean") return undefined;
  const lines = [
    "## DETERMINISTIC COMPLETION RESIDUALS (direct git/filesystem inspection — not worker prose)",
    "- CLEAN: no completion residuals were found.",
  ];
  for (const fingerprint of input.baselinePathFingerprints ?? []) {
    lines.push(`- ${fingerprint.path}: spawn-time fingerprint unchanged`);
  }
  if (input.baselineSha && input.gitDeliveryPolicy === "leave_uncommitted") {
    lines.push(
      "- Git HEAD unchanged from the spawn baseline; no commit was created.",
    );
  }
  if (input.gitDeliveryPolicy === "leave_uncommitted") {
    lines.push(
      "- leave_uncommitted delivery policy verified: only the session-scoped change-set paths remain dirty; unrelated and protected baseline paths are unchanged.",
    );
  }
  return lines.join("\n");
}

interface GitProbe {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runGit(workdir: string, args: string[]): GitProbe {
  const result = spawnSync("git", args, {
    cwd: workdir,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
    encoding: "utf8",
  });
  return {
    ok: result.status === 0,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function cap(items: string[]): string[] {
  return items.slice(0, MAX_RESIDUAL_PATHS);
}

function porcelainPaths(line: string): string[] {
  const rawPath = line.slice(3).trim();
  if (!rawPath) return [];
  const renameParts = rawPath.split(" -> ");
  return renameParts.length > 1
    ? renameParts.map((part) => part.trim()).filter(Boolean)
    : [rawPath];
}

function isOrchestratorOwnedDirtyLine(
  line: string,
  workdir: string,
  artifactsByPath: ReadonlyMap<string, OrchestratorOwnedArtifact>,
): boolean {
  if (!line.startsWith("?? ")) return false;
  const paths = porcelainPaths(line);
  return (
    paths.length > 0 &&
    paths.every((path) => {
      const artifact = artifactsByPath.get(path);
      return artifact ? ownedArtifactStillMatches(workdir, artifact) : false;
    })
  );
}

function ownedArtifactsByPath(
  artifacts: readonly OrchestratorOwnedArtifact[],
): Map<string, OrchestratorOwnedArtifact> {
  return new Map(
    artifacts.map((artifact) => [artifact.path, artifact] as const),
  );
}

/** Whether a porcelain line names only paths that were ALREADY dirty when the
 * session spawned. The spawn baseline (`codingBaselineDirty`) records tracked
 * modifications only (`git diff --name-only HEAD`), so untracked (`??`) lines
 * never match — those are judged against the untracked baseline instead. A
 * rename line is exempt only when BOTH sides were baseline-dirty. */
function isBaselineDirtyLine(
  line: string,
  baselineDirtyPaths: ReadonlySet<string>,
  expectedFingerprints: ReadonlyMap<string, WorkspacePathFingerprint>,
  currentFingerprints: ReadonlyMap<string, WorkspacePathFingerprint>,
): boolean {
  if (baselineDirtyPaths.size === 0) return false;
  if (line.startsWith("?? ")) return false;
  const paths = porcelainPaths(line);
  return (
    paths.length > 0 &&
    paths.every(
      (path) =>
        baselineDirtyPaths.has(path) &&
        workspaceFingerprintMatches(
          expectedFingerprints.get(path),
          currentFingerprints.get(path),
        ),
    )
  );
}

/** Whether an untracked (`??`) porcelain line names only paths that were
 * already untracked when the session spawned (see `baselineUntrackedPaths`).
 * Non-`??` lines never match: a baseline-untracked path that became TRACKED
 * dirty (the worker staged or committed over it) is this run's work. */
function isBaselineUntrackedLine(
  line: string,
  baselineUntrackedPaths: ReadonlySet<string>,
  expectedFingerprints: ReadonlyMap<string, WorkspacePathFingerprint>,
  currentFingerprints: ReadonlyMap<string, WorkspacePathFingerprint>,
): boolean {
  if (baselineUntrackedPaths.size === 0) return false;
  if (!line.startsWith("?? ")) return false;
  const paths = porcelainPaths(line);
  return (
    paths.length > 0 &&
    paths.every(
      (path) =>
        baselineUntrackedPaths.has(path) &&
        workspaceFingerprintMatches(
          expectedFingerprints.get(path),
          currentFingerprints.get(path),
        ),
    )
  );
}

function workspaceFingerprintMatches(
  expected: WorkspacePathFingerprint | undefined,
  current: WorkspacePathFingerprint | undefined,
): boolean {
  return Boolean(
    expected &&
      current &&
      expected.path === current.path &&
      expected.kind === current.kind &&
      expected.mode === current.mode &&
      expected.sha256 === current.sha256,
  );
}

function describeBaselineIntegrityFailure(
  path: string,
  expected: WorkspacePathFingerprint | undefined,
  current: WorkspacePathFingerprint | undefined,
): string | undefined {
  if (!expected) return `${path} (spawn fingerprint unavailable)`;
  if (workspaceFingerprintMatches(expected, current)) return undefined;
  if (!current) return `${path} (current state unreadable or unsupported)`;
  if (expected.kind !== "missing" && current.kind === "missing") {
    return `${path} (deleted after spawn)`;
  }
  if (expected.kind !== current.kind) {
    return `${path} (path type changed after spawn)`;
  }
  if (expected.mode !== current.mode) {
    return `${path} (permissions changed after spawn)`;
  }
  return `${path} (contents changed after spawn)`;
}

/** Whether every path on a porcelain line is an explicitly permitted output
 * of this session. Git's all-files status mode makes untracked paths concrete
 * files rather than collapsed directories, so an allowed `src/a.ts` cannot
 * accidentally exempt an unrelated `src/secret.txt`. */
function isAllowedUncommittedLine(
  line: string,
  allowedUncommittedPaths: ReadonlySet<string>,
  protectedBaselinePaths: ReadonlySet<string>,
): boolean {
  if (allowedUncommittedPaths.size === 0) return false;
  const paths = porcelainPaths(line);
  return (
    paths.length > 0 &&
    paths.every(
      (path) =>
        !protectedBaselinePaths.has(path) && allowedUncommittedPaths.has(path),
    )
  );
}

/**
 * Run every applicable residuals leg and aggregate the verdict. Purely
 * deterministic — no model call, no network; the only side effects are the
 * git subprocess probes.
 */
export async function collectCompletionResiduals(
  input: CompletionResidualsInput,
): Promise<CompletionResidualsResult> {
  const checkedAt = Date.now();
  const residuals: CompletionResidual[] = [];
  const workdir = input.workdir?.trim() || undefined;
  const orchestratorOwnedArtifacts = ownedArtifactsByPath(
    input.orchestratorOwnedArtifacts ?? [],
  );
  // Shared route-mapped app checkouts (TASK_AGENT_WORKDIR_ROUTES → e.g. an
  // agent-home static-apps dir) are pre-existing directories shared by every
  // task the route matches: their dirty paths and unpushed commits predate the
  // run or belong to sibling tasks, so git facts there are not attributable to
  // the reporting session — counting them blocks every completion in that
  // checkout forever. Skip the git legs for that class (envelope legs still
  // apply) and record the skip on the snapshot so the exemption is auditable.
  // An explicit repo claim always wins: a repo-bound task never gets the
  // exemption, so genuinely incomplete work on a task-provisioned workspace
  // still blocks.
  const sharedWorkdirExempt =
    input.sharedRouteWorkdir === true && !input.repoExpected;
  let gitLegsSkipped: CompletionResidualsResult["gitLegsSkipped"];

  // Envelope legs apply regardless of workspace presence: a self-reported
  // failing test contradicts "done" even for a Q&A task.
  const failing = (input.testResults ?? []).filter((row) => row.exitCode !== 0);
  if (failing.length > 0) {
    residuals.push({
      kind: "failing_tests_reported",
      detail: `${failing.length} reported test command(s) exited non-zero`,
      items: cap(failing.map((row) => `${row.command} (exit ${row.exitCode})`)),
    });
  }
  // Residual risks are carried as non-blocking disclosure (see header): a
  // worker who admits "migration not run on prod" must fare no worse than one
  // who stays silent, or the admission stops appearing.
  const disclosedRisks = cap(
    (input.residualRisks ?? [])
      .map((risk) => risk.trim())
      .filter((risk) => risk.length > 0),
  );

  const base = {
    residuals,
    ...(disclosedRisks.length > 0 ? { disclosedRisks } : {}),
    ...(workdir !== undefined ? { workdir } : {}),
    ...(input.gitDeliveryPolicy === "leave_uncommitted"
      ? { gitDeliveryPolicy: input.gitDeliveryPolicy }
      : {}),
    checkedAt,
  };
  const unverifiable = (
    kind: CompletionUnverifiableKind,
    reason: string,
  ): CompletionResidualsResult => ({
    status: "unverifiable",
    unverifiableReason: reason,
    unverifiableKind: kind,
    ...base,
  });

  // A repo-bound task with NO workdir string at all is just as uninspectable
  // as one whose directory vanished — fail closed, never a silent pass.
  if (input.repoExpected && workdir === undefined) {
    return unverifiable(
      "no_workdir",
      "repo-bound task has no inspectable workspace (no session workdir)",
    );
  }

  // Classify the workdir before deciding whether the git legs apply. Any fs
  // error other than a clean "missing" (EACCES, stat races) is a probe
  // FAILURE — it must map to `unverifiable`, never propagate (a throw here
  // would be swallowed by autoVerify's fire-and-forget boundary and wedge the
  // task in `validating` with no event) and never read as "no worktree".
  type WorkdirProbe =
    | "worktree"
    | "missing"
    | "not_directory"
    | "not_worktree"
    | { failed: string };
  let probe: WorkdirProbe = "missing";
  if (workdir !== undefined) {
    try {
      // Single statSync instead of existsSync-then-statSync: the two-call
      // form is a TOCTOU race (the dir can vanish between them) and existsSync
      // swallows the very errno this classification needs. Only a clean
      // "nothing at that path" reads as missing; every other fs error is a
      // probe failure.
      let stats: ReturnType<typeof statSync> | undefined;
      try {
        stats = statSync(workdir);
      } catch (err) {
        // error-policy:J3 untrusted fs state probed; ENOENT/ENOTDIR is the
        // explicit "missing" classification, anything else rethrows into the
        // probe-failure classification below — never a fabricated verdict.
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      }
      if (stats === undefined) probe = "missing";
      else if (!stats.isDirectory()) probe = "not_directory";
      else {
        const inside = runGit(workdir, ["rev-parse", "--is-inside-work-tree"]);
        probe =
          inside.ok && inside.stdout.trim() === "true"
            ? "worktree"
            : "not_worktree";
      }
    } catch (err) {
      // error-policy:J3 a stat race/permission error produces the explicit
      // `unverifiable` classification below, never a thrown escape (autoVerify
      // is fire-and-forget; a throw would strand the task in `validating`
      // with no event) and never a fabricated clean/dirty verdict.
      probe = { failed: err instanceof Error ? err.message : String(err) };
    }
  }

  if (workdir !== undefined && probe !== "worktree") {
    if (typeof probe === "object") {
      // A probe failure is unverifiable for bound AND unbound tasks alike —
      // "could not look" is never license to claim there was nothing to see.
      return unverifiable(
        "probe_failed",
        `workspace probe failed for ${workdir}: ${probe.failed}`,
      );
    }
    if (input.repoExpected) {
      // A declared repo whose workspace cannot be inspected must never
      // promote on faith.
      if (probe === "missing") {
        return unverifiable(
          "missing_dir",
          `workspace directory does not exist: ${workdir}`,
        );
      }
      if (probe === "not_directory") {
        return unverifiable(
          "not_directory",
          `workspace path is not a directory: ${workdir}`,
        );
      }
      return unverifiable(
        "not_worktree",
        `workspace is not a git work tree: ${workdir}`,
      );
    }
    // Unbound + missing/non-git scratch dir: skip the git legs; the envelope
    // legs above still decide the verdict.
  } else if (workdir !== undefined && sharedWorkdirExempt) {
    // A real worktree, but a shared route-mapped checkout (see
    // sharedWorkdirExempt above): deliberately not inspected. The marker rides
    // the persisted snapshot so the skip is visible, never a silent pass.
    gitLegsSkipped = "shared_route_workdir";
  } else if (workdir !== undefined) {
    const status = runGit(workdir, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    if (!status.ok) {
      return unverifiable(
        "git_failed",
        `git status failed in ${workdir}: ${status.stderr.trim() || "unknown error"}`,
      );
    }
    // Pre-existing tracked churn (paths already dirty when the session
    // spawned) is not this run's leftover work — subtract the spawn baseline
    // before counting. The baseline is orchestrator-stamped at spawn, never
    // worker-writable, so the exemption cannot be forged by the agent.
    const baselineDirtyPaths = new Set(
      (input.baselineDirtyPaths ?? [])
        .map((path) => path.trim())
        .filter((path) => path.length > 0),
    );
    const baselineUntrackedPaths = new Set(
      (input.baselineUntrackedPaths ?? [])
        .map((path) => path.trim())
        .filter((path) => path.length > 0),
    );
    const allowedUncommittedPaths = new Set(
      (input.allowedUncommittedPaths ?? [])
        .map((path) => path.trim())
        .filter((path) => path.length > 0),
    );
    const baselinePathFingerprints = sanitizeWorkspacePathFingerprints(
      input.baselinePathFingerprints,
    );
    const expectedFingerprints = new Map(
      baselinePathFingerprints.map((fingerprint) => [
        fingerprint.path,
        fingerprint,
      ]),
    );
    const currentFingerprints = new Map(
      captureWorkspacePathFingerprints(
        workdir,
        baselinePathFingerprints.map((fingerprint) => fingerprint.path),
      ).map((fingerprint) => [fingerprint.path, fingerprint]),
    );
    const protectedBaselinePaths = new Set([
      ...baselineDirtyPaths,
      ...baselineUntrackedPaths,
    ]);
    const baselineIntegrityItems: string[] = [];
    const damagedBaselinePaths = new Set<string>();
    for (const path of protectedBaselinePaths) {
      const failure = describeBaselineIntegrityFailure(
        path,
        expectedFingerprints.get(path),
        currentFingerprints.get(path),
      );
      if (!failure) continue;
      damagedBaselinePaths.add(path);
      baselineIntegrityItems.push(failure);
    }
    if (baselineIntegrityItems.length > 0) {
      residuals.push({
        kind: "baseline_integrity_changed",
        detail: `${baselineIntegrityItems.length} pre-existing dirty path(s) changed or could not be verified`,
        items: cap(baselineIntegrityItems),
      });
    }
    const dirty = status.stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      // Baseline-integrity failures have a dedicated, more actionable
      // residual. Drop matching porcelain lines here so each damaged path is
      // reported once, including paths whose deletion emits no status line.
      .filter(
        (line) =>
          !porcelainPaths(line).some((path) => damagedBaselinePaths.has(path)),
      )
      .filter(
        (line) =>
          !isOrchestratorOwnedDirtyLine(
            line,
            workdir,
            orchestratorOwnedArtifacts,
          ),
      )
      .filter(
        (line) =>
          !isBaselineDirtyLine(
            line,
            baselineDirtyPaths,
            expectedFingerprints,
            currentFingerprints,
          ),
      )
      .filter(
        (line) =>
          !isBaselineUntrackedLine(
            line,
            baselineUntrackedPaths,
            expectedFingerprints,
            currentFingerprints,
          ),
      )
      .filter(
        (line) =>
          !isAllowedUncommittedLine(
            line,
            allowedUncommittedPaths,
            protectedBaselinePaths,
          ),
      );
    if (dirty.length > 0) {
      residuals.push({
        kind: "uncommitted_changes",
        detail: `${dirty.length} uncommitted path(s) in the workspace`,
        // Porcelain lines are `XY path`; keep the status code — it tells the
        // corrective prompt whether the leftover is modified vs untracked.
        items: cap(dirty),
      });
    }

    if (input.gitDeliveryPolicy === "leave_uncommitted") {
      const baselineSha = input.baselineSha?.trim();
      const baselineShaValid = Boolean(
        baselineSha && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(baselineSha),
      );
      const currentHead = runGit(workdir, ["rev-parse", "HEAD"]);
      const currentSha = currentHead.ok ? currentHead.stdout.trim() : undefined;
      if (
        (baselineShaValid && currentSha !== baselineSha) ||
        (!baselineShaValid && currentSha !== undefined)
      ) {
        residuals.push({
          kind: "history_changed",
          detail: baselineShaValid
            ? "workspace HEAD differs from the spawn HEAD under the leave-uncommitted contract"
            : "workspace has a commit but no valid spawn HEAD was captured under the leave-uncommitted contract",
          items: cap(
            [
              baselineShaValid ? `spawn HEAD: ${baselineSha}` : undefined,
              currentSha
                ? `current HEAD: ${currentSha}`
                : "current HEAD: unborn",
            ].filter((item): item is string => item !== undefined),
          ),
        });
      }
    }

    // The upstream leg only applies when an upstream is configured: a local
    // throwaway repo (or a detached/unborn HEAD) legitimately has nothing to
    // push, and treating that as a residual would block every scratch task.
    const upstream =
      input.gitDeliveryPolicy === "leave_uncommitted"
        ? undefined
        : runGit(workdir, [
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{u}",
          ]);
    if (upstream?.ok) {
      const unpushed = runGit(workdir, ["rev-list", "@{u}..HEAD"]);
      if (!unpushed.ok) {
        return unverifiable(
          "git_failed",
          `git rev-list @{u}..HEAD failed in ${workdir}: ${unpushed.stderr.trim() || "unknown error"}`,
        );
      }
      const shas = unpushed.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (shas.length > 0) {
        residuals.push({
          kind: "unpushed_commits",
          detail: `${shas.length} commit(s) not pushed to the upstream branch`,
          items: cap(shas),
        });
      }
    }
  }

  return {
    status: residuals.length > 0 ? "residuals" : "clean",
    ...(gitLegsSkipped !== undefined ? { gitLegsSkipped } : {}),
    ...base,
  };
}

/** One-line summary for event records and log lines. */
export function summarizeResiduals(result: CompletionResidualsResult): string {
  if (result.status === "unverifiable") {
    return `Workspace state could not be verified: ${result.unverifiableReason}`;
  }
  if (result.status === "clean") return "No completion residuals found.";
  return `Completion residuals found: ${result.residuals
    .map((residual) => residual.detail)
    .join("; ")}`;
}

/** Flat detail list for `reEngageOrEscalate`'s `missing` field (what the
 * reflexion post-mortem and the escalation event record). */
export function residualDetails(result: CompletionResidualsResult): string[] {
  if (result.status === "unverifiable" && result.unverifiableReason) {
    return [
      `workspace unverifiable: ${result.unverifiableReason}`,
      ...result.residuals.map((residual) => residual.detail),
    ];
  }
  return result.residuals.map((residual) => residual.detail);
}

/**
 * Corrective prompt sent back to the worker when the gate blocks: enumerates
 * the exact residuals so the re-engaged agent fixes the leftovers instead of
 * re-asserting completion.
 */
export function residualsCorrection(result: CompletionResidualsResult): string {
  const lines: string[] = [
    "Your completion report was blocked by a deterministic workspace check — the task is NOT done yet.",
  ];
  if (result.status === "unverifiable") {
    lines.push(
      `The workspace state could not be verified: ${result.unverifiableReason}.`,
      "Make sure you are working in the task's git workspace, then re-report completion.",
    );
  }
  for (const residual of result.residuals) {
    switch (residual.kind) {
      case "uncommitted_changes":
        lines.push(
          result.gitDeliveryPolicy === "leave_uncommitted"
            ? `- Unexpected workspace paths remain outside the permitted task outputs (${residual.detail}). Remove only paths this session can prove it created; otherwise stop and ask the user for authoritative recovery:`
            : `- Uncommitted changes remain (${residual.detail}). Commit (or intentionally discard) every leftover path:`,
        );
        break;
      case "baseline_integrity_changed":
        lines.push(
          `- Pre-existing dirty workspace paths changed after this session spawned (${residual.detail}). Do not commit, discard, or guess at the user's prior bytes; restore only from an authoritative snapshot, or stop and ask for recovery:`,
        );
        break;
      case "history_changed":
        lines.push(
          `- Repository history changed despite the task's leave-uncommitted delivery contract (${residual.detail}). Stop and ask the user for authoritative recovery; do not alter history or contact any remote:`,
        );
        break;
      case "unpushed_commits":
        lines.push(
          result.gitDeliveryPolicy === "leave_uncommitted"
            ? `- Repository history changed despite the task's leave-uncommitted delivery contract (${residual.detail}). Stop and ask the user for authoritative recovery; do not alter history or contact any remote:`
            : `- Local commits are not pushed (${residual.detail}). Push your branch to its upstream:`,
        );
        break;
      case "failing_tests_reported":
        lines.push(
          `- Your own completion report lists failing test commands (${residual.detail}). Fix them and re-run until green:`,
        );
        break;
    }
    for (const item of residual.items ?? []) lines.push(`    ${item}`);
  }
  lines.push(
    "",
    "When everything above is resolved, report completion again with a valid CompletionEnvelope reflecting the clean state.",
  );
  return lines.join("\n");
}
