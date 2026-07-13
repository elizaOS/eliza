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
 * repo-declaring tasks: when the task/session names a repo, a workdir that is
 * missing or not a git work tree, or a git probe that errors, yields
 * `unverifiable` — never a silent pass. Tasks WITHOUT a declared repo (every
 * ACP session still gets an acp-scratch workdir, even a voice/Q&A task) probe
 * the workdir opportunistically: a real git worktree runs the git legs, a
 * scratch/non-git dir skips them, and the envelope-reported failing tests and
 * residual risks always apply. `ELIZA_ORCHESTRATOR_RESIDUALS_GATE=0` disables
 * the gate (mirrors the `ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY` flag convention).
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";

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
  | "failing_tests_reported"
  | "self_reported_risks";

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

export interface CompletionResidualsResult {
  status: CompletionResidualsStatus;
  residuals: CompletionResidual[];
  /** Why the git legs could not run, when `status` is `unverifiable`. */
  unverifiableReason?: string;
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
  // failing test or residual risk contradicts "done" even for a Q&A task.
  const failing = (input.testResults ?? []).filter((row) => row.exitCode !== 0);
  if (failing.length > 0) {
    residuals.push({
      kind: "failing_tests_reported",
      detail: `${failing.length} reported test command(s) exited non-zero`,
      items: cap(failing.map((row) => `${row.command} (exit ${row.exitCode})`)),
    });
  }
  const risks = (input.residualRisks ?? [])
    .map((risk) => risk.trim())
    .filter((risk) => risk.length > 0);
  if (risks.length > 0) {
    residuals.push({
      kind: "self_reported_risks",
      detail: `${risks.length} self-reported residual risk(s)`,
      items: cap(risks),
    });
  }

  // The git legs run when a workdir is claimed AND either the task declares a
  // repo (fail-closed) or the workdir opportunistically turns out to be a real
  // git worktree. `skipGitLegs` is the repoExpected=false escape for scratch
  // cwds — a non-coding task's acp-scratch dir must not block promotion.
  const workdirIsWorkTree =
    workdir !== undefined &&
    existsSync(workdir) &&
    statSync(workdir).isDirectory() &&
    (() => {
      const inside = runGit(workdir, ["rev-parse", "--is-inside-work-tree"]);
      return inside.ok && inside.stdout.trim() === "true";
    })();
  if (workdir !== undefined && (input.repoExpected || workdirIsWorkTree)) {
    const unverifiable = (reason: string): CompletionResidualsResult => ({
      status: "unverifiable",
      residuals,
      unverifiableReason: reason,
      workdir,
      checkedAt,
    });
    if (!workdirIsWorkTree) {
      // Only reachable when repoExpected: a declared repo whose workspace
      // cannot be inspected must never promote on faith.
      if (!existsSync(workdir)) {
        return unverifiable(`workspace directory does not exist: ${workdir}`);
      }
      if (!statSync(workdir).isDirectory()) {
        return unverifiable(`workspace path is not a directory: ${workdir}`);
      }
      return unverifiable(`workspace is not a git work tree: ${workdir}`);
    }

    const status = runGit(workdir, ["status", "--porcelain"]);
    if (!status.ok) {
      return unverifiable(
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
    residuals,
    ...(workdir !== undefined ? { workdir } : {}),
    checkedAt,
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
      case "self_reported_risks":
        lines.push(
          `- Your completion report lists unresolved residual risks (${residual.detail}). Resolve them or explain concretely why each is acceptable:`,
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
