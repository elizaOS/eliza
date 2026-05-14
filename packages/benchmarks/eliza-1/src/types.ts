/**
 * Public types for the eliza-1 quality + perf bench.
 *
 * The bench is a (task × mode) matrix. A task defines the case set + ground
 * truth shape; a mode is a generator implementation. The runner streams cases
 * through every selected mode, captures per-call metrics, and rolls them up
 * into a console + JSON report.
 */
export type TaskName = "should_respond" | "planner" | `action:${string}`;

export type ModeName = "unguided" | "guided" | "strict-guided" | "cerebras";

/** JSON value type — minimal local definition to avoid pulling @elizaos/core. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A response-handler fixture — input message + the expected shouldRespond label. */
export interface ShouldRespondFixture {
  id: string;
  input: string;
  channelType?: "dm" | "group" | "voice";
  expected: "RESPOND" | "IGNORE" | "STOP";
  /** Optional notes captured with the fixture (not used in scoring). */
  notes?: string;
}

/** A planner fixture — input + expected action name + expected param shape. */
export interface PlannerFixture {
  id: string;
  input: string;
  availableActions: PlannerActionDescriptor[];
  expected_action_name: string;
  /**
   * Expected parameter object. Treated as the ground-truth label set —
   * `label_match` compares values for each listed key (extra keys in the
   * model output are tolerated).
   */
  expected_params: Record<string, JsonValue>;
  notes?: string;
}

/** Compact action descriptor — only what the planner LLM call needs. */
export interface PlannerActionDescriptor {
  name: string;
  description: string;
  parameters: PlannerParameterDescriptor[];
}

export interface PlannerParameterDescriptor {
  name: string;
  type: "string" | "number" | "boolean";
  description: string;
  enum?: string[];
  required?: boolean;
}

/** A per-action fixture — context + expected param shape. */
export interface ActionFixture {
  id: string;
  actionName: string;
  parameters: PlannerParameterDescriptor[];
  context: string;
  expected_params: Record<string, JsonValue>;
  notes?: string;
}

/** Per-call metrics for one (task, mode, case) invocation. */
export interface CaseMetric {
  taskId: TaskName;
  modeId: ModeName;
  caseId: string;
  /** Whether the engine successfully parsed JSON from the model's output. */
  parse_success: boolean;
  /** Whether the parsed JSON matched the expected schema. */
  schema_valid: boolean;
  /**
   * Whether the parsed value matches the ground-truth label (e.g. the
   * expected enum value, or the expected action name + key params). Null
   * when not applicable (e.g. parse failed earlier).
   */
  label_match: boolean | null;
  /** Milliseconds until the first generated token / chunk. */
  first_token_latency_ms: number | null;
  /** End-to-end generation latency in ms. */
  total_latency_ms: number;
  /** Number of output tokens generated (approximated when not exact). */
  tokens_generated: number;
  /** Output tokens / second (computed from tokens_generated and total_latency_ms). */
  tokens_per_second: number;
  /** Ratio of prefix (literal) bytes to total output bytes (for local guided modes). */
  skip_ratio?: number;
  /** Raw text the mode returned, for debugging. */
  raw_output?: string;
  /** Non-fatal generation diagnostics, such as fallback path usage. */
  warnings?: string[];
  /** Error message when the mode threw / produced no output. */
  error?: string;
}

/** Per-mode rollup for one task. */
export interface ModeSummary {
  taskId: TaskName;
  modeId: ModeName;
  cases: number;
  parse_success_rate: number;
  schema_valid_rate: number;
  label_match_rate: number;
  first_token_latency_p50_ms: number | null;
  first_token_latency_p95_ms: number | null;
  total_latency_p50_ms: number;
  total_latency_p95_ms: number;
  mean_tokens_per_second: number;
  /** Mean skip_ratio for this mode+task (when applicable). */
  mean_skip_ratio?: number;
}

/** Top-level bench report. */
export interface BenchReport {
  schemaVersion: "eliza-1-bench-v1";
  generatedAt: string;
  tasks: TaskName[];
  modes: ModeName[];
  /** Modes that were requested but skipped, with the reason for each. */
  skipped: Array<{ modeId: ModeName; reason: string }>;
  /** Per-call records, in run order. */
  cases: CaseMetric[];
  /** Per (task, mode) rollup. */
  summaries: ModeSummary[];
}

/**
 * The interface a "mode" implements. Every mode is invoked the same way: it
 * takes a prompt + a structured-output schema descriptor, runs its generator,
 * and emits a per-call metric. The runner does parsing / scoring uniformly.
 */
export interface ModeAdapter {
  id: ModeName;
  /** Probe: returns null when usable, or a reason string when this mode is skipped. */
  available(): Promise<string | null>;
  /** Run one generation. Returns the timing + raw output (no scoring yet). */
  generate(req: ModeRequest): Promise<ModeResult>;
  /** Tear down any loaded model/server resources after the run completes. */
  cleanup?(): Promise<void>;
}

/** A single generation request shared across all modes. */
export interface ModeRequest {
  taskId: TaskName;
  caseId: string;
  systemPrompt: string;
  userPrompt: string;
  /**
   * JSON schema for the expected response envelope. Modes that support
   * structured/tool-use decoding use this; unguided modes ignore it and
   * are parsed post-hoc.
   */
  jsonSchema: JsonValue;
  /**
   * The grammar-friendly skeleton hint. Modes that compile to GBNF use
   * this; the cerebras mode uses the JSON schema directly via tool-use.
   */
  skeletonHint: SkeletonHint;
  /** Max output tokens for this call. */
  maxTokens: number;
  /** Optional GBNF grammar string (used by strict-guided mode for planner). */
  grammar?: string;
  /** Optional skeleton for prefill plan (carries literal bytes). */
  responseSkeleton?: unknown;
}

/**
 * A compact, mode-agnostic description of the structured-output envelope.
 *
 * For the bench's three tasks, the envelope shapes are:
 *
 *   should_respond:   `{ "shouldRespond": <RESPOND|IGNORE|STOP> }`
 *   planner:          `{ "action": <name>, "parameters": { ... } }`
 *   action:<NAME>:    `{ <param>: <value>, ... }`
 *
 * The skeleton's `freeFields` are the parameter / value positions; modes
 * supporting GBNF can synthesise a lazy grammar from these.
 */
export interface SkeletonHint {
  type: "object";
  freeFields: SkeletonFreeField[];
  /** When set, the entire envelope is a single enum (e.g. should_respond). */
  enumValues?: string[];
  enumKey?: string;
}

export interface SkeletonFreeField {
  key: string;
  kind: "string" | "number" | "boolean" | "enum" | "object";
  enumValues?: string[];
  description?: string;
}

/** What a mode reports back to the runner for one call. */
export interface ModeResult {
  rawOutput: string;
  firstTokenLatencyMs: number | null;
  totalLatencyMs: number;
  tokensGenerated: number;
  /** Non-fatal generation diagnostics, such as fallback path usage. */
  warnings?: string[];
  error?: string;
  /** Optional: skeleton used (for skip_ratio computation). */
  _skeleton?: unknown;
}
