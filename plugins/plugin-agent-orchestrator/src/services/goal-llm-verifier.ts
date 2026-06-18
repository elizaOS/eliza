/**
 * LLM-based goal verifier.
 *
 * On `task_complete` an orchestrator task advances to status `validating`
 * (see {@link OrchestratorTaskService.recordSessionEvent}) and waits for a
 * caller to invoke {@link OrchestratorTaskService.validateTask} with a
 * pass/fail judgment. Historically the only validators were a human
 * pressing a button in the orchestrator UI and the pattern-based
 * sub-agent-completion response evaluator (which only routes back through
 * TASKS when the completion text contains explicit failure markers, not
 * when the work simply doesn't meet the goal).
 *
 * This service is the third validator: a small-model judge that reads the
 * task's `acceptanceCriteria` and the sub-agent's completion evidence and
 * returns a structured `{ passed, summary, missing }` verdict. Callers
 * (HTTP route, orchestrator UI button, future automatic hook) forward the
 * verdict to {@link OrchestratorTaskService.validateTask} using
 * `verifier: "llm-goal-verifier"`.
 *
 * Design constraints:
 *
 * - **No automatic firing.** The verifier is opt-in per task so an LLM
 *   call cannot be triggered without an explicit caller — protects users
 *   from surprise model spend.
 * - **Small model only.** `ModelType.TEXT_SMALL` is sufficient for a
 *   yes/no judgment against a short criteria list and keeps the per-task
 *   cost bounded.
 * - **Defensive parse.** A malformed model response always resolves to
 *   `passed: false` with an explanatory summary, never crashes the route.
 *
 * Refs: elizaOS/eliza#8124
 *
 * @module services/goal-llm-verifier
 */

import { type IAgentRuntime, ModelType } from "@elizaos/core";

/** Stable identifier the verifier stamps onto the `validateTask` payload so
 *  callers can distinguish LLM judgments from human approvals or pattern
 *  evaluators in the orchestrator audit log. */
export const LLM_GOAL_VERIFIER_NAME = "llm-goal-verifier";

/**
 * Whether the orchestrator automatically runs {@link verifyGoalCompletion} when
 * a sub-agent reports a task complete (status → `validating`). Default ON; set
 * `ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY=0` to disable, falling back to the
 * manual `POST /tasks/:id/auto-validate` opt-in path. Mirrors the
 * `ELIZA_ORCHESTRATOR_SMITHERS` flag convention.
 *
 * Auto-firing is additionally gated on the task actually having acceptance
 * criteria (see {@link OrchestratorTaskService}), so a flag-on task with no
 * criteria still incurs no model spend.
 */
export function shouldAutoVerifyGoal(): boolean {
  return process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY !== "0";
}

/**
 * Maximum number of automatic corrective re-sends to a failing sub-agent before
 * the orchestrator stops looping and hands the task to a human
 * (`waiting_on_user`). Prevents a perpetually-failing worker from burning model
 * spend in an unbounded verify→correct→verify cycle.
 */
export const MAX_AUTO_VERIFY_ATTEMPTS = 3;

/**
 * Compose the corrective message body sent back to a sub-agent when automatic
 * verification did not confirm every acceptance criterion. The
 * goal/acceptance-criteria envelope is re-applied by `buildGoalFollowUp`
 * (reason `validation_failed`); this is just the human-readable gap report.
 */
export function buildAutoVerifyCorrection(missing: readonly string[]): string {
  const lines = [
    "Automatic verification did not confirm the task is complete. The following acceptance criteria are not yet demonstrated as met:",
    ...missing.map((criterion) => `- ${criterion}`),
    "",
    "Address each unmet criterion, then re-verify by running the relevant tests/build/typecheck before reporting complete again.",
  ];
  return lines.join("\n");
}

export interface GoalVerificationInput {
  /** The durable task goal — the "what" the worker owns. */
  goal: string;
  /** Explicit acceptance criteria from the task record. May be empty when
   *  the task was opened without any. */
  acceptanceCriteria: readonly string[];
  /** Concatenated completion evidence: sub-agent final reply, test output,
   *  files touched, etc. The caller decides what to include. */
  completionEvidence: string;
}

export interface GoalVerificationResult {
  /** True when every acceptance criterion appears to be met AND no stated
   *  constraint was violated. */
  passed: boolean;
  /** One-sentence human-readable summary suitable for the
   *  `OrchestratorTaskEvent.summary` field. */
  summary: string;
  /** Each criterion the verifier could not confirm from the evidence. Empty
   *  when `passed` is true. Used by the orchestrator to compose a
   *  corrective follow-up prompt. */
  missing: string[];
  /** Raw model response text, kept for the audit log and for tests. */
  rawResponse: string;
}

const EMPTY_CRITERIA_SUMMARY =
  "No acceptance criteria were specified on the task; defaulting to pass.";
const EMPTY_EVIDENCE_SUMMARY =
  "No completion evidence was provided; cannot confirm criteria.";
const MALFORMED_RESPONSE_SUMMARY =
  "Verifier returned a response that could not be parsed; defaulting to fail.";

const MAX_EVIDENCE_CHARS = 12_000;

function trimEvidence(evidence: string): string {
  if (evidence.length <= MAX_EVIDENCE_CHARS) return evidence;
  const headSlice = Math.floor(MAX_EVIDENCE_CHARS * 0.6);
  const tailSlice = MAX_EVIDENCE_CHARS - headSlice - 32;
  return `${evidence.slice(0, headSlice)}\n\n[…evidence truncated…]\n\n${evidence.slice(-tailSlice)}`;
}

function bulletList(items: readonly string[]): string {
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

/** The judge prompt. Kept deliberately small and structured so a small
 *  model can produce parseable JSON reliably. */
export function buildVerificationPrompt(input: GoalVerificationInput): string {
  const criteria = bulletList(input.acceptanceCriteria);
  const evidence = trimEvidence(input.completionEvidence.trim());
  return [
    "You are verifying whether a coding sub-agent satisfied every acceptance criterion of an orchestrator task before the parent agent marks the task done.",
    "",
    `Task goal:`,
    input.goal.trim() || "(no goal text was provided)",
    "",
    "Acceptance criteria (each must hold for the task to pass):",
    criteria,
    "",
    "Completion evidence reported by the sub-agent:",
    "---",
    evidence || "(no evidence)",
    "---",
    "",
    "For EACH numbered criterion above, decide whether the evidence directly demonstrates the criterion holds.",
    "Be strict: if the evidence is silent on a criterion, that criterion fails.",
    "",
    "Respond with a SINGLE JSON object and nothing else. Do not wrap it in ```. Schema:",
    '{ "passed": <true|false>, "summary": "<one sentence under 200 chars>", "missing": ["<criterion text that was NOT confirmed>", ...] }',
    "",
    "`passed` MUST be false whenever `missing` is non-empty.",
    "If every criterion is confirmed, `missing` must be an empty array and `passed` true.",
  ].join("\n");
}

interface ParsedJudgeResponse {
  passed: boolean;
  summary: string;
  missing: string[];
}

function findFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

export function parseJudgeResponse(
  raw: string,
  acceptanceCriteria: readonly string[],
): ParsedJudgeResponse {
  const text = raw.trim();
  const jsonSlice = findFirstJsonObject(text);
  if (!jsonSlice) {
    return {
      passed: false,
      summary: MALFORMED_RESPONSE_SUMMARY,
      missing: [...acceptanceCriteria],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch {
    return {
      passed: false,
      summary: MALFORMED_RESPONSE_SUMMARY,
      missing: [...acceptanceCriteria],
    };
  }
  if (parsed === null || typeof parsed !== "object") {
    return {
      passed: false,
      summary: MALFORMED_RESPONSE_SUMMARY,
      missing: [...acceptanceCriteria],
    };
  }
  const record = parsed as Record<string, unknown>;
  const passedRaw = record.passed;
  const summaryRaw = record.summary;
  const missingRaw = record.missing;
  const missing = Array.isArray(missingRaw)
    ? missingRaw
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0)
    : [];
  // Enforce the schema invariant: missing non-empty ⇒ passed false.
  const passed = passedRaw === true && missing.length === 0;
  const summary =
    typeof summaryRaw === "string" && summaryRaw.trim().length > 0
      ? summaryRaw.trim().slice(0, 280)
      : passed
        ? "All acceptance criteria confirmed by verifier."
        : "Verifier did not confirm every acceptance criterion.";
  return { passed, summary, missing };
}

/**
 * Ask a small model to judge whether the sub-agent's completion evidence
 * satisfies every acceptance criterion. Returns a structured verdict the
 * caller can forward to {@link OrchestratorTaskService.validateTask}.
 *
 * Pure with respect to filesystem and network state — the only side effect
 * is one `runtime.useModel` call.
 */
export async function verifyGoalCompletion(
  runtime: IAgentRuntime,
  input: GoalVerificationInput,
): Promise<GoalVerificationResult> {
  if (input.acceptanceCriteria.length === 0) {
    return {
      passed: true,
      summary: EMPTY_CRITERIA_SUMMARY,
      missing: [],
      rawResponse: "",
    };
  }
  if (input.completionEvidence.trim().length === 0) {
    return {
      passed: false,
      summary: EMPTY_EVIDENCE_SUMMARY,
      missing: [...input.acceptanceCriteria],
      rawResponse: "",
    };
  }
  const prompt = buildVerificationPrompt(input);
  let raw: string;
  try {
    const result = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      stopSequences: [],
    });
    raw = typeof result === "string" ? result : String(result);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      passed: false,
      summary: `Verifier model call failed: ${detail.slice(0, 200)}`,
      missing: [...input.acceptanceCriteria],
      rawResponse: "",
    };
  }
  const parsed = parseJudgeResponse(raw, input.acceptanceCriteria);
  return { ...parsed, rawResponse: raw };
}
