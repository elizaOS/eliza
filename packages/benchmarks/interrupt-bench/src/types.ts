/**
 * Type definitions for InterruptBench scenarios, traces, and results.
 *
 * The scenario JSON shape mirrors the Wave 0 contract — see the package
 * README for prose and the `scenarios/` directory for examples.
 */

// ---------------------------------------------------------------------------
// Scenario JSON
// ---------------------------------------------------------------------------

export type InterruptionType = "addition" | "revision" | "retraction";

export interface ScenarioRoom {
  id: string;
  kind: "dm" | "group" | "channel";
  owner?: string;
  members?: string[];
}

export interface ScenarioUser {
  id: string;
  role: "OWNER" | "ADMIN" | "USER" | "GUEST" | "SYSTEM";
}

export interface ScenarioOpenThread {
  id: string;
  owner: string;
  status: "active" | "waiting" | "paused" | "stopped" | "completed";
  instruction: string;
  roomId: string;
  pendingExternalActions?: string[];
  pendingPromptId?: string;
}

export interface ScenarioScheduledTask {
  id: string;
  owner: string;
  description: string;
  dueAt?: number;
}

export interface ScenarioPendingPrompt {
  id: string;
  askedIn: string;
  askedAt: number;
  question: string;
}

export interface ScenarioMemoryItem {
  id?: string;
  roomId?: string;
  text: string;
}

export interface ScenarioSetup {
  agentId: string;
  rooms: ScenarioRoom[];
  users: ScenarioUser[];
  openThreads: ScenarioOpenThread[];
  scheduledTasks: ScenarioScheduledTask[];
  memory: ScenarioMemoryItem[];
  pendingPrompts?: ScenarioPendingPrompt[];
}

export interface ScenarioScriptStep {
  /** Virtual milliseconds since scenario start. */
  t: number;
  channel: string;
  sender: string;
  text: string;
}

// ---------------------------------------------------------------------------
// Expected state
// ---------------------------------------------------------------------------

interface CountBounds {
  min: number;
  max: number;
}

export interface ExpectedReplies {
  count: CountBounds;
  mustContain?: string[];
  shortAck?: boolean;
}

/**
 * Each expected-thread entry supports two styles:
 *   - exact id match: `{ id, status }` (existing thread, expected end-status)
 *   - structural match: `{ ownerEq, statusEq, instructionContains, count? }`
 *     (new thread the agent should have created)
 */
export interface ExpectedThread {
  id?: string;
  status?: ScenarioOpenThread["status"];
  ownerEq?: string;
  statusEq?: ScenarioOpenThread["status"];
  instructionContains?: string[];
  instructionExcludes?: string[];
  count?: number;
}

export interface ExpectedScheduledTask {
  owner?: string;
  descriptionContains?: string[];
  descriptionExcludes?: string[];
}

export interface ExpectedFinalState {
  threads: ExpectedThread[];
  scheduledTasks: ExpectedScheduledTask[];
  repliesByChannel: Record<string, ExpectedReplies>;
  externalSideEffects?: {
    emailsSent?: number;
  };
  pendingPrompts?: Record<string, { resolved?: boolean }>;
}

// ---------------------------------------------------------------------------
// Expected trace
// ---------------------------------------------------------------------------

export interface ExpectedTrace {
  stage1Calls: CountBounds;
  plannerCalls?: CountBounds;
  boundaryViolations: number;
  intent?: "RESPOND" | "IGNORE";
  abortFired?: boolean;
  preemptMode?: "ack-and-stop" | "ignore" | "direct-reply";
  threadOps?: Array<{ type: string; workThreadId?: string }>;
  threadOpsContains?: string[];
}

// ---------------------------------------------------------------------------
// Full scenario shape
// ---------------------------------------------------------------------------

export interface ResponseRubric {
  judgePrompt: string;
  passRequiredForBonus: boolean;
}

export interface Scenario {
  id: string;
  category: string;
  interruptionType: InterruptionType;
  weight: number;
  description?: string;
  setup: ScenarioSetup;
  script: ScenarioScriptStep[];
  /** Virtual ms after the last script step to wait for handlers to settle. */
  quiesceAfterMs?: number;
  expectedFinalState: ExpectedFinalState;
  expectedTrace: ExpectedTrace;
  responseRubric: ResponseRubric;
}

// ---------------------------------------------------------------------------
// Runtime trace
// ---------------------------------------------------------------------------

export interface TraceEvent {
  /** Virtual ms since scenario start. */
  t: number;
  type: TraceEventType;
  channel?: string;
  sender?: string;
  text?: string;
  fieldName?: string;
  reason?: string;
  preemptMode?: string;
  detail?: Record<string, unknown>;
}

export type TraceEventType =
  | "message_in"
  | "handler_start"
  | "handler_end"
  | "stage1_call"
  | "stage1_response"
  | "planner_call"
  | "abort_fired"
  | "preempt"
  | "thread_op"
  | "reply_emitted"
  | "boundary_violation"
  | "external_side_effect"
  | "error";

// ---------------------------------------------------------------------------
// Scenario result
// ---------------------------------------------------------------------------

export interface AxisScore {
  raw: number;
  weight: number;
  weighted: number;
  notes: string[];
}

export interface ScenarioResult {
  scenarioId: string;
  category: string;
  weight: number;
  axes: {
    state: AxisScore;
    intent: AxisScore;
    routing: AxisScore;
    trace: AxisScore;
    boundary: AxisScore;
    latency: AxisScore;
  };
  /** Σ weighted, before any -5 boundary penalty. */
  rawScore: number;
  /** Final score for this scenario, 0..1 (boundary penalty applied at aggregate level). */
  score: number;
  boundaryViolated: boolean;
  judge?: {
    pass: boolean;
    reason: string;
  };
  trace: TraceEvent[];
  durationMs: number;
}

export interface BenchmarkReport {
  startedAt: string;
  finishedAt: string;
  mode: "scripted" | "cerebras";
  model?: string;
  aggregate: number;
  judgeBonus: number;
  finalScore: number;
  passTier: "fail" | "70" | "82" | "90" | "95";
  scenarios: ScenarioResult[];
}
