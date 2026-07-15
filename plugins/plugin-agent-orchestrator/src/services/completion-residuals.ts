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
  testResults?: ReadonlyArray<{
    command: string;
    exitCode: number;
    summary: string;
  }>;
  residualRisks?: readonly string[];
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
  } else if (workdir !== undefined) {
    const status = runGit(workdir, ["status", "--porcelain"]);
    if (!status.ok) {
      return unverifiable(
        "git_failed",
        `git status failed in ${workdir}: ${status.stderr.trim() || "unknown error"}`,
      );
    }
    const dirty = status.stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    if (dirty.length > 0) {
      residuals.push({
        kind: "uncommitted_changes",
        detail: `${dirty.length} uncommitted path(s) in the workspace`,
        // Porcelain lines are `XY path`; keep the status code — it tells the
        // corrective prompt whether the leftover is modified vs untracked.
        items: cap(dirty),
      });
    }

    // The upstream leg only applies when an upstream is configured: a local
    // throwaway repo (or a detached/unborn HEAD) legitimately has nothing to
    // push, and treating that as a residual would block every scratch task.
    const upstream = runGit(workdir, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{u}",
    ]);
    if (upstream.ok) {
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
          `- Uncommitted changes remain (${residual.detail}). Commit (or intentionally discard) every leftover path:`,
        );
        break;
      case "unpushed_commits":
        lines.push(
          `- Local commits are not pushed (${residual.detail}). Push your branch to its upstream:`,
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
