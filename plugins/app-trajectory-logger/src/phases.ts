import type {
  TrajectoryDetail,
  UIEvaluationEvent,
  UILlmCall,
  UIProviderAccess,
  UIToolEvent,
} from "./api-client";

export type PhaseName = "HANDLE" | "PLAN" | "ACTION" | "EVALUATE";
export type PhaseStatus = "idle" | "active" | "done" | "skipped" | "error";

export const PHASES: readonly PhaseName[] = [
  "HANDLE",
  "PLAN",
  "ACTION",
  "EVALUATE",
] as const;

export interface PhaseSummary {
  phase: PhaseName;
  status: PhaseStatus;
  summary: string | null;
  llmCalls: UILlmCall[];
  providerAccesses: UIProviderAccess[];
  toolEvents: UIToolEvent[];
  evaluationEvents: UIEvaluationEvent[];
}

const HANDLE_TYPES = new Set(["should_respond", "compose_state"]);
const PLAN_TYPES = new Set(["reasoning", "response", "action"]);
const EVALUATE_TYPES = new Set([
  "evaluation",
  "evaluator",
  "observation_extraction",
  "turn_complete",
]);

function phaseOf(call: UILlmCall): PhaseName | null {
  const t = (call.stepType || call.purpose || "").toLowerCase();
  if (HANDLE_TYPES.has(t)) return "HANDLE";
  if (PLAN_TYPES.has(t)) return "PLAN";
  if (EVALUATE_TYPES.has(t)) return "EVALUATE";
  return null;
}

function shouldRespondDecision(call: UILlmCall): string | null {
  const text = (call.response ?? "").trim();
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]) as Record<string, unknown>;
      const a = obj.action ?? obj.decision ?? obj.shouldRespond;
      if (typeof a === "string" && a.length > 0) return a.toUpperCase();
    } catch {
      /* fall through */
    }
  }
  const word = text.match(/\b(RESPOND|REPLY|ANSWER|IGNORE|STOP|SKIP)\b/i);
  return word ? word[0].toUpperCase() : null;
}

export function extractShouldRespondDecision(
  call: UILlmCall,
): { decision: string; reasoning?: string } | null {
  const decision = shouldRespondDecision(call);
  if (!decision) return null;
  let reasoning: string | undefined;
  const m = (call.response ?? "").match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]) as Record<string, unknown>;
      const r = obj.reasoning ?? obj.rationale;
      if (typeof r === "string") reasoning = r;
    } catch {
      /* ignore */
    }
  }
  return reasoning ? { decision, reasoning } : { decision };
}

export function summarizePhases(
  detail: TrajectoryDetail | null,
  options: { trajectoryActive?: boolean } = {},
): PhaseSummary[] {
  const llmCalls = detail?.llmCalls ?? [];
  const providerAccesses = detail?.providerAccesses ?? [];
  const toolEvents = detail?.toolEvents ?? [];
  const evaluationEvents = detail?.evaluationEvents ?? [];

  const handleCalls = llmCalls.filter((c) => phaseOf(c) === "HANDLE");
  const planCalls = llmCalls.filter((c) => phaseOf(c) === "PLAN");
  const evalCalls = llmCalls.filter((c) => phaseOf(c) === "EVALUATE");

  const handle = summarizeHandle(handleCalls, providerAccesses);
  const plan = summarizePlan(planCalls);
  const action = summarizeAction(toolEvents);
  const evaluate = summarizeEvaluate(evalCalls, evaluationEvents);

  const out: PhaseSummary[] = [
    {
      phase: "HANDLE",
      ...handle,
      llmCalls: handleCalls,
      providerAccesses,
      toolEvents: [],
      evaluationEvents: [],
    },
    {
      phase: "PLAN",
      ...plan,
      llmCalls: planCalls,
      providerAccesses: [],
      toolEvents: [],
      evaluationEvents: [],
    },
    {
      phase: "ACTION",
      ...action,
      llmCalls: [],
      providerAccesses: [],
      toolEvents,
      evaluationEvents: [],
    },
    {
      phase: "EVALUATE",
      ...evaluate,
      llmCalls: evalCalls,
      providerAccesses: [],
      toolEvents: [],
      evaluationEvents,
    },
  ];

  // For an in-flight trajectory: the latest non-idle phase is the one
  // currently running. Promote its status to `active` so the dot pulses.
  if (options.trajectoryActive) {
    let last = -1;
    for (let i = 0; i < out.length; i++) {
      if (out[i].status !== "idle") last = i;
    }
    if (
      last >= 0 &&
      last < out.length - 1 &&
      out[last].status === "done" &&
      out.slice(last + 1).every((p) => p.status === "idle")
    ) {
      out[last] = { ...out[last], status: "active" };
    }
  }
  return out;
}

function summarizeHandle(
  llmCalls: UILlmCall[],
  providerAccesses: UIProviderAccess[],
): { status: PhaseStatus; summary: string | null } {
  const respond = llmCalls.find(
    (c) => (c.stepType || c.purpose || "").toLowerCase() === "should_respond",
  );
  if (respond) {
    const d = shouldRespondDecision(respond);
    if (d) {
      const skip = /IGNORE|STOP|SKIP/i.test(d);
      return { status: skip ? "skipped" : "done", summary: d.toLowerCase() };
    }
    return { status: "done", summary: "decided" };
  }
  if (llmCalls.length > 0 || providerAccesses.length > 0) {
    return { status: "done", summary: `${providerAccesses.length} ctx` };
  }
  return { status: "idle", summary: null };
}

function summarizePlan(llmCalls: UILlmCall[]): {
  status: PhaseStatus;
  summary: string | null;
} {
  const last = llmCalls[llmCalls.length - 1];
  if (!last) return { status: "idle", summary: null };
  if (last.actionType) return { status: "done", summary: last.actionType };
  return { status: "done", summary: "respond" };
}

function summarizeAction(events: UIToolEvent[]): {
  status: PhaseStatus;
  summary: string | null;
} {
  if (events.length === 0) return { status: "idle", summary: null };
  const e = events[events.length - 1];
  const name = e.actionName || e.toolName || e.name || "action";
  if (e.type === "tool_error" || e.error || e.success === false) {
    return { status: "error", summary: `${name} ✗` };
  }
  if (
    e.type === "tool_result" ||
    e.status === "completed" ||
    e.success === true
  ) {
    return { status: "done", summary: `${name} ✓` };
  }
  if (e.status === "skipped") return { status: "skipped", summary: name };
  return { status: "active", summary: name };
}

function summarizeEvaluate(
  llmCalls: UILlmCall[],
  events: UIEvaluationEvent[],
): { status: PhaseStatus; summary: string | null } {
  if (events.length > 0) {
    const e = events[events.length - 1];
    const name = e.evaluatorName || e.name || "evaluator";
    if (e.error || e.success === false) {
      return { status: "error", summary: `${name} ✗` };
    }
    if (e.decision)
      return { status: "done", summary: `${name}: ${e.decision}` };
    return { status: "done", summary: name };
  }
  if (llmCalls.length > 0) return { status: "done", summary: "evaluated" };
  return { status: "idle", summary: null };
}
