/**
 * Phase classifier. Maps the runtime's `stepType` / `purpose` taxonomy onto
 * the four UI phases the user wants to see: HANDLE → PLAN → ACTION → EVALUATE.
 *
 * The agent runtime emits LLM calls with these `stepType` values (see
 * `inferTrajectoryLlmStepType` in `packages/agent/src/runtime/trajectory-internals.ts`):
 *
 *   should_respond, compose_state, reasoning, response, evaluation,
 *   observation_extraction, turn_complete, coordination, action, ...
 *
 * Plus tool/evaluator events emitted as `toolEvents` / `evaluationEvents`
 * on the trajectory detail.
 */

import type {
  TrajectoryDetail,
  UIEvaluationEvent,
  UILlmCall,
  UIProviderAccess,
  UIToolEvent,
} from "./api-client";

export type PhaseName = "HANDLE" | "PLAN" | "ACTION" | "EVALUATE";

export const PHASES: readonly PhaseName[] = [
  "HANDLE",
  "PLAN",
  "ACTION",
  "EVALUATE",
] as const;

/** Visual status for the thin status indicator next to each phase chip. */
export type PhaseStatus = "idle" | "active" | "done" | "skipped" | "error";

export interface PhaseSummary {
  phase: PhaseName;
  status: PhaseStatus;
  /** Concise one-liner for the chip (e.g. "respond", "REPLY", "POSTGRES_QUERY ✓"). */
  summary: string | null;
  llmCalls: UILlmCall[];
  providerAccesses: UIProviderAccess[];
  toolEvents: UIToolEvent[];
  evaluationEvents: UIEvaluationEvent[];
}

const HANDLE_STEP_TYPES = new Set(["should_respond", "compose_state"]);

const PLAN_STEP_TYPES = new Set(["reasoning", "response", "action"]);

const EVALUATE_STEP_TYPES = new Set([
  "evaluation",
  "evaluator",
  "observation_extraction",
  "turn_complete",
]);

function classifyLlmCall(call: UILlmCall): PhaseName | null {
  const stepType = (call.stepType ?? "").toLowerCase();
  const purpose = (call.purpose ?? "").toLowerCase();
  if (HANDLE_STEP_TYPES.has(stepType) || HANDLE_STEP_TYPES.has(purpose)) {
    return "HANDLE";
  }
  if (PLAN_STEP_TYPES.has(stepType) || PLAN_STEP_TYPES.has(purpose)) {
    return "PLAN";
  }
  if (EVALUATE_STEP_TYPES.has(stepType) || EVALUATE_STEP_TYPES.has(purpose)) {
    return "EVALUATE";
  }
  return null;
}

/** Pull the JSON shouldRespond decision off a should_respond LLM response, if present. */
export function extractShouldRespondDecision(
  call: UILlmCall,
): { decision: string; reasoning?: string } | null {
  const text = (call.response ?? "").trim();
  if (!text) return null;
  const directIgnore = /\b(IGNORE|STOP|SKIP)\b/i;
  const directRespond = /\b(RESPOND|ANSWER|REPLY)\b/i;
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as Record<string, unknown>;
      const action = String(
        parsed.action ?? parsed.decision ?? parsed.shouldRespond ?? "",
      ).trim();
      const reasoning =
        typeof parsed.reasoning === "string"
          ? parsed.reasoning
          : typeof parsed.rationale === "string"
            ? parsed.rationale
            : undefined;
      if (action) {
        return { decision: action.toUpperCase(), reasoning };
      }
    }
  } catch {
    // fall through to regex match
  }
  if (directIgnore.test(text)) {
    const word = text.match(directIgnore)?.[0];
    if (word) return { decision: word.toUpperCase() };
  }
  if (directRespond.test(text)) {
    const word = text.match(directRespond)?.[0];
    if (word) return { decision: word.toUpperCase() };
  }
  return null;
}

function summarizeHandle(
  llmCalls: UILlmCall[],
  providerAccesses: UIProviderAccess[],
): { status: PhaseStatus; summary: string | null } {
  const respondCall = llmCalls.find(
    (c) =>
      (c.stepType ?? "").toLowerCase() === "should_respond" ||
      (c.purpose ?? "").toLowerCase() === "should_respond",
  );
  if (respondCall) {
    const decision = extractShouldRespondDecision(respondCall);
    if (decision) {
      const respond = /RESPOND|ANSWER|REPLY/i.test(decision.decision);
      const ignored = /IGNORE|STOP|SKIP/i.test(decision.decision);
      return {
        status: respond ? "done" : ignored ? "skipped" : "done",
        summary: decision.decision.toLowerCase(),
      };
    }
    return {
      status: "done",
      summary: "decided",
    };
  }
  const composeCall = llmCalls.find(
    (c) =>
      (c.stepType ?? "").toLowerCase() === "compose_state" ||
      (c.purpose ?? "").toLowerCase() === "compose_state",
  );
  if (composeCall || providerAccesses.length > 0) {
    return {
      status: "done",
      summary: `${providerAccesses.length} ctx`,
    };
  }
  return { status: "idle", summary: null };
}

function summarizePlan(llmCalls: UILlmCall[]): {
  status: PhaseStatus;
  summary: string | null;
} {
  const planCall = llmCalls[llmCalls.length - 1];
  if (!planCall) return { status: "idle", summary: null };
  const actionType = (planCall.actionType ?? "").trim();
  if (actionType) {
    return { status: "done", summary: actionType };
  }
  const text = (planCall.response ?? "").trim();
  if (!text) return { status: "active", summary: "thinking" };
  // Try to pull an action name out of common JSON shapes.
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as Record<string, unknown>;
      const candidate = parsed.action ?? parsed.actionName ?? parsed.name;
      if (typeof candidate === "string" && candidate.length > 0) {
        return { status: "done", summary: candidate };
      }
    }
  } catch {
    // ignore
  }
  return { status: "done", summary: "respond" };
}

function summarizeAction(toolEvents: UIToolEvent[]): {
  status: PhaseStatus;
  summary: string | null;
} {
  if (toolEvents.length === 0) return { status: "idle", summary: null };
  const latest = toolEvents[toolEvents.length - 1];
  const name = latest.actionName ?? latest.toolName ?? latest.name ?? "action";
  if (
    latest.type === "tool_error" ||
    latest.error ||
    latest.success === false
  ) {
    return { status: "error", summary: `${name} ✗` };
  }
  if (
    latest.type === "tool_result" ||
    latest.status === "completed" ||
    latest.success === true
  ) {
    return { status: "done", summary: `${name} ✓` };
  }
  if (latest.status === "skipped") {
    return { status: "skipped", summary: `${name} skipped` };
  }
  return { status: "active", summary: name };
}

function summarizeEvaluate(
  llmCalls: UILlmCall[],
  evaluationEvents: UIEvaluationEvent[],
): { status: PhaseStatus; summary: string | null } {
  if (evaluationEvents.length > 0) {
    const latest = evaluationEvents[evaluationEvents.length - 1];
    const name = latest.evaluatorName ?? latest.name ?? "evaluator";
    if (latest.error || latest.success === false) {
      return { status: "error", summary: `${name} ✗` };
    }
    if (latest.decision) {
      return { status: "done", summary: `${name}: ${latest.decision}` };
    }
    if (latest.success === true || latest.status === "completed") {
      return { status: "done", summary: `${name} ✓` };
    }
    return { status: "active", summary: name };
  }
  if (llmCalls.length > 0) {
    return { status: "done", summary: "evaluated" };
  }
  return { status: "idle", summary: null };
}

/**
 * Compute the four phase summaries from a fully-loaded TrajectoryDetail.
 * For active/in-flight trajectories, missing phases stay `idle` until the
 * runtime fires the corresponding LLM call or tool/evaluation event.
 */
export function summarizePhases(
  detail: TrajectoryDetail | null,
  options: { trajectoryActive?: boolean } = {},
): PhaseSummary[] {
  const llmCalls = detail?.llmCalls ?? [];
  const providerAccesses = detail?.providerAccesses ?? [];
  const toolEvents = detail?.toolEvents ?? [];
  const evaluationEvents = detail?.evaluationEvents ?? [];

  const handleCalls = llmCalls.filter((c) => classifyLlmCall(c) === "HANDLE");
  const planCalls = llmCalls.filter((c) => classifyLlmCall(c) === "PLAN");
  const evalCalls = llmCalls.filter((c) => classifyLlmCall(c) === "EVALUATE");

  const handle = summarizeHandle(handleCalls, providerAccesses);
  const plan = summarizePlan(planCalls);
  const action = summarizeAction(toolEvents);
  const evaluate = summarizeEvaluate(evalCalls, evaluationEvents);

  // For an active trajectory, the *last* phase that has data is the one
  // that's currently running — promote it to "active" if the next phases
  // have nothing yet.
  const summaries: Array<{ status: PhaseStatus; summary: string | null }> = [
    handle,
    plan,
    action,
    evaluate,
  ];
  if (options.trajectoryActive) {
    let lastWithData = -1;
    for (let i = 0; i < summaries.length; i++) {
      if (summaries[i].status !== "idle") lastWithData = i;
    }
    // If a later phase is still idle while an earlier phase finished, the
    // current step is "in flight" — surface that as `active` on the most
    // recent finished phase.
    if (
      lastWithData >= 0 &&
      summaries[lastWithData].status === "done" &&
      lastWithData < summaries.length - 1 &&
      summaries.slice(lastWithData + 1).every((s) => s.status === "idle")
    ) {
      summaries[lastWithData] = {
        ...summaries[lastWithData],
        status: "active",
      };
    }
  }

  return [
    {
      phase: "HANDLE",
      status: summaries[0].status,
      summary: summaries[0].summary,
      llmCalls: handleCalls,
      providerAccesses,
      toolEvents: [],
      evaluationEvents: [],
    },
    {
      phase: "PLAN",
      status: summaries[1].status,
      summary: summaries[1].summary,
      llmCalls: planCalls,
      providerAccesses: [],
      toolEvents: [],
      evaluationEvents: [],
    },
    {
      phase: "ACTION",
      status: summaries[2].status,
      summary: summaries[2].summary,
      llmCalls: [],
      providerAccesses: [],
      toolEvents,
      evaluationEvents: [],
    },
    {
      phase: "EVALUATE",
      status: summaries[3].status,
      summary: summaries[3].summary,
      llmCalls: evalCalls,
      providerAccesses: [],
      toolEvents: [],
      evaluationEvents,
    },
  ];
}
