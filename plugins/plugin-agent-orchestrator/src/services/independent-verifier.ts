/**
 * Independent read-only verifier sub-agent (#8898, EPIC #8884).
 *
 * The goal verifier judges only what the coding sub-agent narrated — it can't
 * independently run `bun test`, read a file, or inspect the diff. Best practice
 * (Agent-as-a-Judge / Validation Chain) spawns a SEPARATE read-only agent that
 * verifies by execution. This module builds that verifier's spawn prompt, runs
 * it (via an injected spawn-and-await so it unit-tests without ACP), and turns
 * its CompletionEnvelope into an execution-grounded verdict for `validateTask`.
 *
 * "Read-only" is enforced by the prompt + the spawn's approval preset (the spawn
 * API has no hard tool whitelist): the verifier is told to run/read/inspect only,
 * never edit.
 */

import {
  type CompletionEnvelope,
  parseCompletionEnvelope,
} from "./completion-envelope.js";

/** Build the independent verifier's spawn prompt. */
export function buildIndependentVerifierPrompt(input: {
  goal: string;
  acceptanceCriteria: string[];
  diffSummary?: string;
}): string {
  const criteria =
    input.acceptanceCriteria.length > 0
      ? input.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")
      : "(none provided — verify the goal is genuinely, observably met)";
  return [
    "--- Independent Verification ---",
    "You are an INDEPENDENT verifier. A coding agent claims the task below is done. Do NOT trust its narration — confirm by EXECUTION.",
    "Read-only: you may run tests/build/typecheck/lint, read files, and inspect the git diff. Do NOT edit, write, or commit anything.",
    "",
    "--- Goal ---",
    input.goal.trim(),
    ...(input.diffSummary ? ["--- Claimed change ---", input.diffSummary] : []),
    "--- Acceptance Criteria ---",
    criteria,
    "",
    "Steps: run the relevant tests/build/typecheck; read the changed files; inspect `git diff`. For EACH acceptance criterion, decide met/unmet from command output you actually ran.",
    "Then output ONLY a CompletionEnvelope JSON block: set testResults to the commands you ran (with real exitCodes), acceptanceCriteriaStatus to your per-criterion verdict with the command output as evidence, and residualRisks to anything you couldn't confirm.",
  ].join("\n");
}

export interface IndependentVerifierVerdict {
  /** True only when every criterion is met AND every test command exited 0. */
  passed: boolean;
  /** Criteria the verifier marked unmet (or all, when the envelope was unusable). */
  unmet: string[];
  /** Test commands that exited non-zero. */
  failedCommands: string[];
  /** One-line human summary. */
  summary: string;
  /** True when no usable envelope came back (caller should not auto-pass). */
  inconclusive: boolean;
}

/** Turn the verifier's parsed envelope into an execution-grounded verdict. */
export function verifierVerdict(
  completionText: string,
): IndependentVerifierVerdict {
  const parse = parseCompletionEnvelope(completionText);
  if (!parse.present || !parse.ok) {
    return {
      passed: false,
      unmet: [],
      failedCommands: [],
      summary:
        "Independent verifier returned no usable CompletionEnvelope — treat as unverified.",
      inconclusive: true,
    };
  }
  return verdictFromEnvelope(parse.envelope);
}

/** Verdict directly from a (already-parsed) envelope. */
export function verdictFromEnvelope(
  env: CompletionEnvelope,
): IndependentVerifierVerdict {
  const unmet = env.acceptanceCriteriaStatus
    .filter((c) => !c.met)
    .map((c) => c.criterion);
  const failedCommands = env.testResults
    .filter((t) => t.exitCode !== 0)
    .map((t) => t.command);
  const missingArtifacts =
    env.artifactsVerified === false ? (env.missingArtifacts ?? []) : [];
  // No criteria reported is itself inconclusive — a real verifier confirms each.
  const inconclusive =
    env.acceptanceCriteriaStatus.length === 0 || missingArtifacts.length > 0;
  const passed =
    !inconclusive && unmet.length === 0 && failedCommands.length === 0;
  const summary = passed
    ? `Independent verification passed: ${env.acceptanceCriteriaStatus.length} criteria met, ${env.testResults.length} command(s) green.`
    : missingArtifacts.length > 0
      ? `Independent verifier found missing artifacts: ${missingArtifacts.join(", ")}.`
      : inconclusive
        ? "Independent verifier reported no per-criterion status — unverified."
        : `Independent verification failed: ${unmet.length} unmet criteria, ${failedCommands.length} failing command(s).`;
  return { passed, unmet, failedCommands, summary, inconclusive };
}

/** Default-on for code-change tasks; gated by ELIZA_ORCHESTRATOR_INDEPENDENT_VERIFY. */
export function shouldRunIndependentVerify(
  getSetting: (key: string) => string | undefined | null,
  hasCodeChanges: boolean,
): boolean {
  const raw = getSetting("ELIZA_ORCHESTRATOR_INDEPENDENT_VERIFY");
  if (raw === "0" || raw === "false") return false;
  if (raw === "1" || raw === "always") return true;
  // Default: on for code-change tasks only.
  return hasCodeChanges;
}

export interface IndependentVerifyDeps {
  /**
   * Spawn the read-only verifier with `prompt` and resolve its final completion
   * text. The caller wires this to AcpService.spawnSession + awaiting the
   * session's task_complete; tests inject a stub.
   */
  spawnAndAwait: (prompt: string) => Promise<string>;
}

/**
 * Run an independent verification pass and return the verdict. A spawn failure
 * is inconclusive (never a false pass) so the caller keeps the task in
 * validating rather than promoting it on a verifier crash.
 */
export async function runIndependentVerification(
  input: { goal: string; acceptanceCriteria: string[]; diffSummary?: string },
  deps: IndependentVerifyDeps,
): Promise<IndependentVerifierVerdict> {
  const prompt = buildIndependentVerifierPrompt(input);
  let completion: string;
  try {
    completion = await deps.spawnAndAwait(prompt);
  } catch (error) {
    return {
      passed: false,
      unmet: [],
      failedCommands: [],
      summary: `Independent verifier failed to run: ${
        error instanceof Error ? error.message : String(error)
      }`,
      inconclusive: true,
    };
  }
  return verifierVerdict(completion);
}
