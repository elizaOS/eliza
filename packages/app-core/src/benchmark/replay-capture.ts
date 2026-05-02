import { asRecord } from "@elizaos/shared";
import z from "zod";

const UnknownRecord = z.record(z.string(), z.unknown());

const ReplayToolCallSchema = z
  .object({
    name: z.string().min(1),
    input: z.record(z.string(), z.unknown()).default({}),
    output: z.unknown().optional(),
  })
  .strict();

const ReplayLlmSchema = z
  .object({
    model: z.string().min(1).default("unknown"),
    prompt: z.string().default(""),
    response: z.string().default(""),
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    latency_ms: z.number().nonnegative().optional(),
  })
  .strict();

export const ReplayEventSchema = z
  .object({
    id: z.string().min(1),
    ts: z.string().datetime().nullable(),
    actor: z.string().min(1),
    kind: z.string().min(1),
    message: z.string().default(""),
    decision_type: z.string().optional(),
    tool_call: ReplayToolCallSchema.optional(),
    llm: ReplayLlmSchema.optional(),
    raw: UnknownRecord.optional(),
  })
  .strict();

const ReplayOutcomeSchema = z
  .object({
    success: z.boolean().nullable(),
    status: z.string().default("unknown"),
    summary: z.string().default(""),
  })
  .strict();

export const ReplayArtifactSchema = z
  .object({
    schema_version: z.literal("1.0"),
    source: z.literal("parallax_debug_capture"),
    run: z
      .object({
        run_id: z.string().min(1),
        captured_at: z.string().datetime(),
        mode: z.enum(["solo", "swarm", "unknown"]).default("unknown"),
        prompt: z.string().default(""),
        repo: z.string().optional(),
        workdir: z.string().optional(),
      })
      .strict(),
    orchestrator: z
      .object({
        session_id: z.string().optional(),
        task_label: z.string().optional(),
      })
      .strict(),
    events: z.array(ReplayEventSchema),
    outcome: ReplayOutcomeSchema,
  })
  .strict();

export type ReplayArtifact = z.infer<typeof ReplayArtifactSchema>;

function pickString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function pickNumber(
  record: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function pickBoolean(
  record: Record<string, unknown>,
  keys: string[],
): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function toIsoTimestamp(value: unknown): string | null {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1_000_000_000_000 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  return null;
}

function extractEvents(input: unknown): Record<string, unknown>[] {
  if (Array.isArray(input)) {
    return input.map((entry) => asRecord(entry)).filter(Boolean) as Record<
      string,
      unknown
    >[];
  }

  const root = asRecord(input);
  if (!root) return [];

  const candidates = [
    root.events,
    root.records,
    root.trace,
    root.entries,
    root.steps,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate
        .map((entry) => asRecord(entry))
        .filter(Boolean) as Record<string, unknown>[];
    }
  }

  return [];
}

function inferMode(
  input: Record<string, unknown>,
): "solo" | "swarm" | "unknown" {
  const mode = pickString(input, ["mode", "run_mode"]);
  if (mode === "solo" || mode === "swarm") return mode;
  const agentCount = pickNumber(input, ["agent_count", "workers"]);
  if (typeof agentCount === "number" && agentCount > 1) return "swarm";
  if (typeof agentCount === "number" && agentCount === 1) return "solo";
  return "unknown";
}

function normalizeEvent(
  event: Record<string, unknown>,
  index: number,
): z.infer<typeof ReplayEventSchema> {
  const id =
    pickString(event, ["id", "event_id", "uuid", "trace_id"]) ??
    `event-${index + 1}`;

  const ts = toIsoTimestamp(event.timestamp ?? event.ts ?? event.time);

  const actor =
    pickString(event, ["actor", "agent", "agent_name", "source", "owner"]) ??
    "orchestrator";

  const kind =
    pickString(event, ["kind", "type", "event", "name"]) ?? "unknown";

  const message =
    pickString(event, ["message", "text", "note", "reasoning"]) ?? "";

  const toolName = pickString(event, ["tool", "tool_name", "command_name"]);
  const toolInput = asRecord(event.tool_input ?? event.input ?? event.params);
  const toolCall = toolName
    ? {
        name: toolName,
        input: toolInput ?? {},
        output: event.tool_output ?? event.output,
      }
    : undefined;

  const model = pickString(event, ["model", "model_name"]);
  const prompt = pickString(event, ["prompt", "user_prompt", "input_text"]);
  const response = pickString(event, ["response", "output_text", "assistant"]);
  const llm =
    model || prompt || response
      ? {
          model: model ?? "unknown",
          prompt: prompt ?? "",
          response: response ?? "",
          prompt_tokens: pickNumber(event, ["prompt_tokens", "input_tokens"]),
          completion_tokens: pickNumber(event, [
            "completion_tokens",
            "output_tokens",
          ]),
          latency_ms: pickNumber(event, [
            "latency_ms",
            "latency",
            "duration_ms",
          ]),
        }
      : undefined;

  const decisionType = pickString(event, [
    "decision_type",
    "decisionType",
    "purpose",
  ]);

  return ReplayEventSchema.parse({
    id,
    ts,
    actor,
    kind,
    message,
    ...(decisionType ? { decision_type: decisionType } : {}),
    ...(toolCall ? { tool_call: toolCall } : {}),
    ...(llm ? { llm } : {}),
    raw: event,
  });
}

export function normalizeParallaxCapture(input: unknown): ReplayArtifact {
  const root = asRecord(input) ?? {};
  const events = extractEvents(input).map((event, index) =>
    normalizeEvent(event, index),
  );

  const runId =
    pickString(root, ["run_id", "session_id", "id", "task_id"]) ??
    `run-${Date.now()}`;
  const capturedAt =
    toIsoTimestamp(root.captured_at ?? root.timestamp ?? Date.now()) ??
    new Date().toISOString();

  const outcomeSuccess = pickBoolean(root, ["success"]);
  const outcomeStatus =
    pickString(root, ["status", "result", "final_status"]) ?? "unknown";
  const outcomeSummary =
    pickString(root, ["summary", "final_summary", "result_summary"]) ?? "";

  return ReplayArtifactSchema.parse({
    schema_version: "1.0",
    source: "parallax_debug_capture",
    run: {
      run_id: runId,
      captured_at: capturedAt,
      mode: inferMode(root),
      prompt: pickString(root, ["prompt", "task", "original_prompt"]) ?? "",
      repo: pickString(root, ["repo", "repository"]),
      workdir: pickString(root, ["workdir", "cwd"]),
    },
    orchestrator: {
      session_id: pickString(root, ["orchestrator_session_id", "session_id"]),
      task_label: pickString(root, ["task_label", "orchestrator_task"]),
    },
    events,
    outcome: {
      success: outcomeSuccess ?? null,
      status: outcomeStatus,
      summary: outcomeSummary,
    },
  });
}
