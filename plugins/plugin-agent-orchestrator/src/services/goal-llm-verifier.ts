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

import {
  createJsonFileTrajectoryRecorder,
  type IAgentRuntime,
  isTrajectoryRecordingEnabled,
  ModelType,
  type RecordedStage,
} from "@elizaos/core";

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
 * Pick the concrete proof a sub-agent must paste for a given unmet criterion.
 * A demanding manager doesn't accept "I fixed it" — it names the exact artifact
 * that would settle the question (a passing build/test line, a screenshot, a
 * scenario trajectory) and asks for it inline. Keyword-driven so the guidance
 * matches the kind of work the criterion describes; falls back to the
 * build/test default that fits most coding criteria.
 */
function proofDemandFor(criterion: string): string {
  const c = criterion.toLowerCase();
  if (
    /\b(ui|screen|page|view|button|render|css|layout|visual|frontend|component|storybook)\b/.test(
      c,
    )
  ) {
    return "capture a full-page screenshot of the working UI (paste the file path) AND, if it is a route in the app, the URL you reached";
  }
  if (
    /\b(agent|prompt|conversation|reply|respond|chat|trajectory|scenario|behaviou?r|tool[- ]?call)\b/.test(
      c,
    )
  ) {
    return "produce a scenario trajectory against a live model and paste the report path (and the decisive turn) — do not just assert the behavior";
  }
  if (/\b(url|endpoint|deploy|live|reachable|http|served|api)\b/.test(c)) {
    return "paste the reachable, non-loopback URL and the response (status line / curl output) proving it serves — a localhost/127.0.0.1 URL does NOT count";
  }
  if (/\b(perf|latenc|benchmark|speed|throughput|memory)\b/.test(c)) {
    return "paste the before/after measurement output (the actual numbers, not a claim)";
  }
  if (
    /\b(test|spec|coverage|unit|e2e|integration|vitest|jest)\b/.test(c) ||
    /\b(build|compile|typecheck|lint|tsc)\b/.test(c)
  ) {
    return "run the command and paste its passing output tail (the summary line, e.g. the test/build/typecheck result)";
  }
  return "run build/typecheck/tests for the affected package and paste the passing output, plus the exact diff hunk that satisfies this criterion";
}

/**
 * Render the explicit evidence checklist appended to every correction. Each
 * unmet criterion becomes a markdown checkbox the worker MUST return ticked
 * WITH the artifact pasted next to it, and carries its per-item proof demand
 * (reusing {@link proofDemandFor}). A ticked box with no pasted artifact is
 * treated as not done — verification will fail again.
 */
function buildEvidenceChecklist(missing: readonly string[]): string {
  return [
    "Evidence checklist — return EVERY box ticked WITH the artifact pasted inline (a ticked box and no artifact = not done):",
    ...missing.map(
      (criterion) => `- [ ] ${criterion} — proof: ${proofDemandFor(criterion)}`,
    ),
  ].join("\n");
}

/**
 * Compose the corrective message body sent back to a sub-agent when automatic
 * verification did not confirm every acceptance criterion. The
 * goal/acceptance-criteria envelope is re-applied by `buildGoalFollowUp`
 * (reason `validation_failed`); this is just the human-readable gap report.
 *
 * Behaves like a demanding manager whose tone ESCALATES per attempt — a
 * manager who has been fobbed off twice does not keep asking nicely:
 *
 * - **Attempt 1** — collegial: "verification didn't confirm X; here's the
 *   proof to produce" (the per-criterion proof demands).
 * - **Attempt 2** — pointed/socratic: direct questions per unmet criterion
 *   ("which command did you run, and what was its output? Paste it."), and a
 *   note that a prior attempt already failed.
 * - **Attempt 3+ (final)** — firm last-chance: this is the final automated
 *   attempt before the task is parked for a human; every checklist item must be
 *   proven inline or the task is escalated.
 *
 * For EACH unmet criterion it names the specific proof the worker must produce
 * and re-report WITH (a passing build/test line, a screenshot for UI, a
 * scenario trajectory for agent behavior, a reachable URL for a deploy), and
 * appends an explicit {@link buildEvidenceChecklist} the worker must tick with
 * the artifact, so the next completion arrives with verifiable evidence instead
 * of another plausible-but-unproven claim.
 *
 * @param missing unmet acceptance criteria the verifier could not confirm.
 * @param attempt 1-based correction attempt (defaults to 1 so callers that
 *        don't track attempts keep the collegial behavior). Clamped to
 *        `[1, MAX_AUTO_VERIFY_ATTEMPTS]`; attempt `MAX_AUTO_VERIFY_ATTEMPTS`
 *        is the final-chance phrasing before escalation to a human.
 */
export function buildAutoVerifyCorrection(
  missing: readonly string[],
  attempt = 1,
): string {
  const stage = Math.min(
    Math.max(Math.trunc(attempt) || 1, 1),
    MAX_AUTO_VERIFY_ATTEMPTS,
  );
  const isFinal = stage >= MAX_AUTO_VERIFY_ATTEMPTS;

  const header: string[] = [];
  const proofSection: string[] = [];
  const closing: string[] = [];

  if (stage <= 1) {
    // Attempt 1 — collegial gap report.
    header.push(
      "Automatic verification did not confirm the task is complete. A plausible description is NOT proof — each criterion below is still unproven and must be backed by a concrete artifact.",
      "",
      "For EACH unmet acceptance criterion, do the work and then paste the exact proof named:",
    );
    proofSection.push(
      ...missing.map(
        (criterion) =>
          `- ${criterion}\n    → proof to produce: ${proofDemandFor(criterion)}`,
      ),
    );
    closing.push(
      "Then report complete AGAIN, and this time INCLUDE that proof inline in your final message: the actual command output (build/typecheck/test summary lines), screenshot path(s) for any UI, scenario trajectory report path for any agent behavior, and reachable non-loopback URL(s) for anything deployed. Claims without pasted evidence will fail verification again.",
    );
  } else if (!isFinal) {
    // Attempt 2 — pointed, socratic interrogation; call out the prior failure.
    header.push(
      `This is attempt ${stage}: your previous "complete" report ALREADY FAILED automatic verification — the same criteria are still unproven. I am not going to take "it works" on faith. Answer these directly, per criterion, with pasted evidence:`,
      "",
    );
    proofSection.push(
      ...missing.map(
        (criterion) =>
          `- ${criterion}\n    → Exactly which command did you run for this, and what was its EXACT output? Paste it. Did you actually open/observe/run it, or did you assume it works? Show: ${proofDemandFor(criterion)}`,
      ),
    );
    closing.push(
      "Do not re-report complete until you can answer every question above with a pasted artifact. A restatement of what you intended to do is not an answer — I need the actual output, path, or URL.",
    );
  } else {
    // Attempt 3+ — final automated attempt before human escalation.
    header.push(
      `FINAL ATTEMPT (attempt ${stage} of ${MAX_AUTO_VERIFY_ATTEMPTS}). Your work has already failed automatic verification twice. This is the LAST automated correction — if the next report is not fully proven, the task is PARKED and ESCALATED to a human, and you do not get another pass.`,
      "",
      "Every unmet criterion below MUST be proven INLINE in your next message — no exceptions, no promises of future work:",
    );
    proofSection.push(
      ...missing.map(
        (criterion) =>
          `- ${criterion}\n    → REQUIRED proof (paste it or the task is escalated): ${proofDemandFor(criterion)}`,
      ),
    );
    closing.push(
      'If you cannot produce the proof for a criterion, say so explicitly and explain the blocker — do NOT report complete with the gap unproven. An unproven "complete" report at this stage parks the task for a human.',
    );
  }

  const lines = [
    ...header,
    ...proofSection,
    "",
    ...closing,
    "",
    buildEvidenceChecklist(missing),
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

/**
 * Optional recording context for {@link verifyGoalCompletion}. When
 * `recordTrajectory` is supplied AND trajectory recording is enabled
 * (`ELIZA_TRAJECTORY_RECORDING` != 0), the single grill model call is written
 * as a one-stage trajectory under the active trajectory dir
 * (`ELIZA_TRAJECTORY_DIR` → state-dir/trajectories). That stage carries the
 * verifier prompt and the model's verdict — exactly the model-boundary record
 * the scenario native-export converts to an `eliza_native_v1` training row and
 * the production observability stack reads. Pure unit tests pass no context, so
 * they record nothing.
 */
export interface GoalVerificationOptions {
  recordTrajectory?: {
    /** Durable task room id, used as the trajectory roomId for correlation. */
    roomId?: string;
    /** Durable task id, used to label the recorded root message. */
    taskId?: string;
    /** Reporting sub-agent session id, used to label the recorded root message. */
    sessionId?: string;
  };
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
 *  model can produce parseable JSON reliably, but written as a demanding,
 *  evidence-first manager: each criterion must be backed by CONCRETE PROOF in
 *  the evidence, not a plausible-sounding claim. */
export function buildVerificationPrompt(input: GoalVerificationInput): string {
  const criteria = bulletList(input.acceptanceCriteria);
  const evidence = trimEvidence(input.completionEvidence.trim());
  return [
    "You are a demanding engineering manager doing final sign-off on a coding sub-agent's work before the parent agent marks the task done. Your job is to be skeptical, not agreeable: a task passes ONLY when the evidence PROVES every acceptance criterion, not when the sub-agent merely claims it.",
    "",
    `Task goal:`,
    input.goal.trim() || "(no goal text was provided)",
    "",
    "Acceptance criteria (each must hold for the task to pass):",
    criteria,
    "",
    "Completion evidence collected for the sub-agent (git diffstat/changeset, deliverable + final reply, verified URLs, test/build/typecheck output, artifact references):",
    "---",
    evidence || "(no evidence)",
    "---",
    "",
    "For EACH numbered criterion above, find the SPECIFIC place in the evidence that directly demonstrates it with concrete proof. Acceptable proof, depending on the criterion:",
    "- a passing test / build / typecheck / lint output line (e.g. a green summary line) for 'tests pass', 'builds', 'typechecks';",
    "- a concrete diff hunk in the changeset showing the exact code that implements the criterion;",
    "- a reachable, NON-loopback URL (localhost / 127.0.0.1 / ::1 do NOT count as reachable) for 'deployed' / 'live' / 'served';",
    "- a screenshot or trajectory artifact reference for UI or agent-behavior criteria.",
    "",
    "Hard rules — apply them strictly:",
    "- A plausible-but-unproven claim FAILS. 'I ran the tests and they pass', 'the page renders correctly', or 'it's deployed' with NO pasted output / URL / screenshot in the evidence is NOT proof — mark that criterion as missing.",
    "- If the evidence is silent on a criterion, or only describes intent / future work, that criterion FAILS.",
    "- If the evidence contains a failure marker (a non-zero exit, a failing/red test line, an error/traceback, a loopback-only URL where a public one is required) relevant to a criterion, that criterion FAILS.",
    "- Do not give the benefit of the doubt. When in doubt, mark it missing.",
    "",
    "Respond with a SINGLE JSON object and nothing else. Do not wrap it in ```. Schema:",
    '{ "passed": <true|false>, "summary": "<one sentence under 200 chars>", "missing": ["<criterion text that was NOT proven>", ...] }',
    "",
    "`passed` MUST be false whenever `missing` is non-empty.",
    "If and only if every criterion is backed by concrete proof in the evidence, `missing` must be an empty array and `passed` true.",
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
    // error-policy:J3 untrusted-input sanitizing — an unparseable model verdict
    // fails closed (passed:false, all criteria unmet), never a fake-valid pass.
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
  options?: GoalVerificationOptions,
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
  const startedAt = Date.now();
  let raw: string;
  try {
    const result = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      stopSequences: [],
    });
    raw = typeof result === "string" ? result : String(result);
  } catch (err) {
    // error-policy:J1 boundary translation — a failed verifier model call
    // becomes a structured fail verdict naming the error, never a fake pass.
    const detail = err instanceof Error ? err.message : String(err);
    return {
      passed: false,
      summary: `Verifier model call failed: ${detail.slice(0, 200)}`,
      missing: [...input.acceptanceCriteria],
      rawResponse: "",
    };
  }
  // Record the grill model boundary (prompt + verdict) so the scenario
  // native-export and production observability capture this supervision call.
  // Pure observability: a recorder fault must never block or alter the verdict,
  // so the whole thing is guarded and only logs on failure.
  await recordVerifierBoundary(runtime, options?.recordTrajectory, {
    goal: input.goal,
    prompt,
    response: raw,
    startedAt,
    endedAt: Date.now(),
  });
  const parsed = parseJudgeResponse(raw, input.acceptanceCriteria);
  return { ...parsed, rawResponse: raw };
}

/** Agent/sender labels used when the runtime has no agentId (e.g. a partial
 *  test runtime); a non-empty string keeps the trajectory file path valid. */
const GOAL_VERIFIER_TRAJECTORY_AGENT = "orchestrator-goal-verifier";

/**
 * Write the verifier's single model call as a one-stage trajectory under the
 * active trajectory dir, so the scenario native-export converts it to an
 * `eliza_native_v1` row and the observability stack can read the grill
 * boundary. No-op unless a recording context is supplied and
 * `ELIZA_TRAJECTORY_RECORDING` is on. Fully guarded: this is observability, and
 * a recorder fault must never break {@link verifyGoalCompletion}'s verdict.
 */
async function recordVerifierBoundary(
  runtime: IAgentRuntime,
  context: GoalVerificationOptions["recordTrajectory"],
  call: {
    goal: string;
    prompt: string;
    response: string;
    startedAt: number;
    endedAt: number;
  },
): Promise<void> {
  if (!context || !isTrajectoryRecordingEnabled()) return;
  try {
    const recorder = createJsonFileTrajectoryRecorder();
    const trajectoryId = recorder.startTrajectory({
      agentId: runtime.agentId || GOAL_VERIFIER_TRAJECTORY_AGENT,
      roomId: context.roomId,
      rootMessage: {
        id:
          context.sessionId ??
          context.taskId ??
          `goal-verify-${call.startedAt}`,
        text: call.goal.trim() || "(goal verification)",
        sender: GOAL_VERIFIER_TRAJECTORY_AGENT,
      },
    });
    const stage: RecordedStage = {
      stageId: `${trajectoryId}:goal-verify`,
      kind: "evaluation",
      startedAt: call.startedAt,
      endedAt: call.endedAt,
      latencyMs: call.endedAt - call.startedAt,
      model: {
        modelType: ModelType.TEXT_SMALL,
        provider: "default",
        prompt: call.prompt,
        response: call.response,
        // We only get the verdict text back from `useModel`, not token usage,
        // so cost is recorded as 0 (and the price-table lookup short-circuits)
        // rather than emitting a misleading missing-price warning per call.
        costUsd: 0,
      },
    };
    await recorder.recordStage(trajectoryId, stage);
    await recorder.endTrajectory(trajectoryId, "finished");
  } catch (err) {
    // error-policy:J7 diagnostics-must-not-kill-the-loop — a trajectory-recorder
    // fault is warned and must never alter or block the verifier verdict.
    runtime.logger?.warn?.(
      { err: err instanceof Error ? err.message : String(err) },
      "[goal-llm-verifier] failed to record verifier trajectory (non-fatal)",
    );
  }
}
