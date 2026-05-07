#!/usr/bin/env bun
/**
 * `run-cerebras` — drives one v5 native-tool-calling trajectory against the
 * Cerebras `gpt-oss-120b` (or `gpt-oss-20b`) endpoint and writes the recorded
 * trajectory JSON to `./trajectories/<id>.json`.
 *
 * Spec: PLAN.md §19.2 / §19.3.
 *
 * The script is intentionally self-contained: it does NOT spin up a full
 * AgentRuntime. Instead, a `LocalRecorder` defined inline implements the
 * §18.1 schema and stays structurally compatible with the runtime recorder.
 *
 * Cerebras serves an OpenAI-compatible API, so this harness calls
 * `/v1/chat/completions` directly while plugin-openai/plugin-cerebras cover
 * runtime provider integration.
 *
 * Flags (PLAN.md §19.3):
 *   --message "..."         Provide message inline (default: positional arg).
 *   --scenario <name>       Load from research/native-tool-calling/scenarios/<name>.json.
 *   --no-record             Skip writing JSON.
 *   --no-tty                Plain output for logs.
 *   --stages-only           One line per stage (compact).
 *   --model <name>          Override default `gpt-oss-120b`.
 *   --prompt-cache-key <k>  Stable Cerebras prompt cache routing hint.
 *   --payload <mode>        json|gzip|msgpack|msgpack-gzip.
 *   --repeat <N>            Repeat the same run for cache hit measurement.
 *   --compare-batching      Compare serial vs concurrent batch-style scenarios.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { computeCallCostUsd, formatUsd } from "./lib/cost-table";

// ---------------------------------------------------------------------------
// Trajectory schema (mirrors PLAN.md §18.1)
// ---------------------------------------------------------------------------

interface UsageBreakdown {
  promptTokens: number;
  completionTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  cachedTokens?: number;
  cached_tokens?: number;
  totalTokens: number;
  timeInfo?: {
    queueTimeSec?: number;
    promptTimeSec?: number;
    completionTimeSec?: number;
    totalTimeSec?: number;
    created?: number;
  };
  raw?: unknown;
}

type PayloadMode = "json" | "gzip" | "msgpack" | "msgpack-gzip";

interface RequestPayloadRecord {
  mode: PayloadMode;
  contentType: string;
  contentEncoding?: "gzip";
  uncompressedBytes: number;
  encodedBytes: number;
  compressionRatio: number;
}

interface ToolCallRecord {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
}

interface ModelCallRecord {
  modelType: string;
  modelName?: string;
  provider: string;
  prompt: string;
  messages?: unknown[];
  tools?: Array<{ name?: string; description?: string }>;
  toolChoice?: unknown;
  response: string;
  toolCalls?: ToolCallRecord[];
  usage?: UsageBreakdown;
  cached_tokens?: number;
  finishReason?: string;
  costUsd?: number;
  latencyMs?: number;
  promptCacheKey?: string;
  requestPayload?: RequestPayloadRecord;
}

interface ToolStageRecord {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  success: boolean;
  durationMs: number;
}

interface EvaluationRecord {
  success: boolean;
  decision: string;
  thought?: string;
  messageToUser?: string;
  [key: string]: unknown;
}

interface CacheStageRecord {
  segmentHashes: string[];
  prefixHash: string;
  diffFromPriorStage?: { added: number; unchanged: number; removed: number };
}

interface RecordedStage {
  stageId: string;
  kind:
    | "messageHandler"
    | "planner"
    | "tool"
    | "evaluation"
    | "subPlanner"
    | "compaction";
  iteration?: number;
  parentStageId?: string;
  startedAt: number;
  endedAt: number;
  latencyMs: number;
  model?: ModelCallRecord;
  tool?: ToolStageRecord;
  evaluation?: EvaluationRecord;
  cache?: CacheStageRecord;
}

interface TrajectoryMetrics {
  totalLatencyMs: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUsd: number;
  plannerIterations: number;
  toolCallsExecuted: number;
  toolCallFailures: number;
  evaluatorFailures: number;
  finalDecision?: "FINISH" | "CONTINUE" | "max_iterations" | "error";
}

interface RecordedTrajectory {
  trajectoryId: string;
  agentId: string;
  roomId?: string;
  rootMessage: { id: string; text: string; sender?: string };
  startedAt: number;
  endedAt?: number;
  status: "running" | "finished" | "errored";
  metadata?: Record<string, unknown>;
  stages: RecordedStage[];
  metrics: TrajectoryMetrics;
}

// ---------------------------------------------------------------------------
// LocalRecorder — captures stage events into an in-memory trajectory and
// flushes the final JSON to disk on `end`.
// ---------------------------------------------------------------------------

class LocalRecorder {
  private trajectory: RecordedTrajectory;
  private printer: (stage: RecordedStage, idx: number) => void;

  constructor(args: {
    agentId: string;
    roomId: string;
    rootMessage: { id: string; text: string; sender?: string };
    metadata?: Record<string, unknown>;
    printer: (stage: RecordedStage, idx: number) => void;
  }) {
    const id = `tj-${crypto.randomBytes(4).toString("hex")}`;
    this.printer = args.printer;
    this.trajectory = {
      trajectoryId: id,
      agentId: args.agentId,
      roomId: args.roomId,
      rootMessage: args.rootMessage,
      startedAt: Date.now(),
      status: "running",
      metadata: args.metadata,
      stages: [],
      metrics: {
        totalLatencyMs: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        totalCostUsd: 0,
        plannerIterations: 0,
        toolCallsExecuted: 0,
        toolCallFailures: 0,
        evaluatorFailures: 0,
      },
    };
  }

  get id(): string {
    return this.trajectory.trajectoryId;
  }

  get snapshot(): RecordedTrajectory {
    return this.trajectory;
  }

  record(stage: RecordedStage): void {
    const idx = this.trajectory.stages.length;
    const recordedStage = cloneForRecord(stage);
    this.trajectory.stages.push(recordedStage);

    const m = this.trajectory.metrics;
    m.totalLatencyMs += recordedStage.latencyMs;
    if (recordedStage.model?.usage) {
      m.totalPromptTokens += recordedStage.model.usage.promptTokens ?? 0;
      m.totalCompletionTokens +=
        recordedStage.model.usage.completionTokens ?? 0;
      m.totalCacheReadTokens +=
        recordedStage.model.usage.cacheReadInputTokens ?? 0;
      m.totalCacheCreationTokens +=
        recordedStage.model.usage.cacheCreationInputTokens ?? 0;
    }
    if (typeof recordedStage.model?.costUsd === "number") {
      m.totalCostUsd += recordedStage.model.costUsd;
    }
    if (recordedStage.kind === "planner") m.plannerIterations += 1;
    if (recordedStage.kind === "tool") {
      m.toolCallsExecuted += 1;
      if (recordedStage.tool && !recordedStage.tool.success)
        m.toolCallFailures += 1;
    }
    if (
      recordedStage.kind === "evaluation" &&
      recordedStage.evaluation?.success === false
    ) {
      m.evaluatorFailures += 1;
    }
    if (recordedStage.evaluation?.decision === "FINISH") {
      m.finalDecision = "FINISH";
    } else if (
      recordedStage.evaluation?.decision &&
      recordedStage.evaluation.decision !== "FINISH"
    ) {
      m.finalDecision = "CONTINUE";
    }

    this.printer(recordedStage, idx);
  }

  end(status: "finished" | "errored"): RecordedTrajectory {
    this.trajectory.status = status;
    this.trajectory.endedAt = Date.now();
    if (!this.trajectory.metrics.finalDecision && status === "errored") {
      this.trajectory.metrics.finalDecision = "error";
    }
    return this.trajectory;
  }

  async flush(targetDir: string): Promise<string> {
    await fs.mkdir(targetDir, { recursive: true });
    const filePath = path.join(
      targetDir,
      `${this.trajectory.trajectoryId}.json`,
    );
    await fs.writeFile(
      filePath,
      JSON.stringify(this.trajectory, null, 2),
      "utf8",
    );
    return filePath;
  }
}

function cloneForRecord<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---------------------------------------------------------------------------
// Pretty-printing
// ---------------------------------------------------------------------------

function ttyEnabled(noTty: boolean): boolean {
  if (noTty) return false;
  if (process.env.NO_COLOR) return false;
  return process.stdout.isTTY === true;
}

function colorize(noTty: boolean) {
  const wrap = (code: string, text: string) => {
    if (!ttyEnabled(noTty)) return text;
    return `\x1b[${code}m${text}\x1b[0m`;
  };
  return {
    dim: (t: string) => wrap("2", t),
    bold: (t: string) => wrap("1", t),
    red: (t: string) => wrap("31", t),
    green: (t: string) => wrap("32", t),
    yellow: (t: string) => wrap("33", t),
    cyan: (t: string) => wrap("36", t),
  };
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// Cerebras client (direct fetch — keeps the script free of plugin spin-up)
// ---------------------------------------------------------------------------

const CEREBRAS_BASE_URL =
  process.env.OPENAI_BASE_URL ?? "https://api.cerebras.ai/v1";

interface CerebrasChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

interface CerebrasToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface CerebrasResponse {
  id?: string;
  model?: string;
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    time_info?: {
      queue_time?: number;
      prompt_time?: number;
      completion_time?: number;
      total_time?: number;
      created?: number;
    };
  };
  time_info?: {
    queue_time?: number;
    prompt_time?: number;
    completion_time?: number;
    total_time?: number;
    created?: number;
  };
}

type JsonSchemaResponseFormat = {
  type: "json_schema";
  json_schema: {
    name: string;
    strict: boolean;
    schema: Record<string, unknown>;
  };
};

type CerebrasResponseFormat =
  | { type: "json_object" }
  | { type: "text" }
  | JsonSchemaResponseFormat;

class GracefulSkip extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GracefulSkip";
  }
}

async function loadMsgpackEncoder(): Promise<
  ((value: unknown) => Uint8Array | Buffer) | null
> {
  const importOptional = (
    specifier: string,
  ): Promise<Record<string, unknown>> =>
    import(specifier) as Promise<Record<string, unknown>>;
  const candidates = [
    async () => {
      const mod = await importOptional("@msgpack/msgpack");
      return mod.encode as ((value: unknown) => Uint8Array) | undefined;
    },
    async () => {
      const mod = await importOptional("msgpackr");
      return mod.pack as ((value: unknown) => Uint8Array | Buffer) | undefined;
    },
    async () => {
      const mod = (await importOptional("msgpack-lite")) as {
        encode?: (value: unknown) => Uint8Array | Buffer;
        default?: { encode?: (value: unknown) => Uint8Array | Buffer };
      };
      return mod.encode ?? mod.default?.encode;
    },
  ];

  for (const candidate of candidates) {
    try {
      const encode = await candidate();
      if (typeof encode === "function") return encode;
    } catch {
      // Optional dependency is not installed in this workspace.
    }
  }
  return null;
}

async function encodeRequestPayload(
  body: Record<string, unknown>,
  mode: PayloadMode,
): Promise<{
  body: string | Blob;
  headers: Record<string, string>;
  record: RequestPayloadRecord;
}> {
  const json = JSON.stringify(body);
  const uncompressedBytes = Buffer.byteLength(json);
  let raw: string | Uint8Array | Buffer = json;
  let contentType = "application/json";

  if (mode === "msgpack" || mode === "msgpack-gzip") {
    const encode = await loadMsgpackEncoder();
    if (!encode) {
      throw new GracefulSkip(
        `--payload ${mode} requested, but no MessagePack encoder is installed. Install @msgpack/msgpack, msgpackr, or msgpack-lite to run this mode.`,
      );
    }
    raw = encode(body);
    contentType = "application/vnd.msgpack";
  }

  let encoded: string | Uint8Array | Buffer = raw;
  const headers: Record<string, string> = { "content-type": contentType };
  if (mode === "gzip" || mode === "msgpack-gzip") {
    const source =
      typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw);
    encoded = gzipSync(source, { level: 5 });
    headers["content-encoding"] = "gzip";
  }

  const encodedBytes =
    typeof encoded === "string"
      ? Buffer.byteLength(encoded)
      : encoded.byteLength;
  const record: RequestPayloadRecord = {
    mode,
    contentType,
    contentEncoding:
      headers["content-encoding"] === "gzip" ? "gzip" : undefined,
    uncompressedBytes,
    encodedBytes,
    compressionRatio:
      uncompressedBytes > 0 ? encodedBytes / uncompressedBytes : 1,
  };

  if (typeof encoded === "string") {
    return { body: encoded, headers, record };
  }
  const binary = Buffer.from(encoded);
  const arrayBuffer = binary.buffer.slice(
    binary.byteOffset,
    binary.byteOffset + binary.byteLength,
  ) as ArrayBuffer;
  return { body: new Blob([arrayBuffer]), headers, record };
}

async function cerebrasChat(args: {
  apiKey: string;
  model: string;
  messages: CerebrasChatMessage[];
  tools?: CerebrasToolDef[];
  toolChoice?: "auto" | "required" | "none";
  responseFormat?: CerebrasResponseFormat;
  promptCacheKey?: string;
  payloadMode: PayloadMode;
  maxCompletionTokens?: number;
}): Promise<{
  rawResponseText: string;
  toolCalls: ToolCallRecord[];
  finishReason: string;
  usage: UsageBreakdown;
  requestPayload: RequestPayloadRecord;
}> {
  const body: Record<string, unknown> = {
    model: args.model,
    messages: args.messages,
    stream: false,
  };
  if (args.tools && args.tools.length > 0) body.tools = args.tools;
  if (args.toolChoice) body.tool_choice = args.toolChoice;
  if (args.responseFormat) body.response_format = args.responseFormat;
  if (args.promptCacheKey) body.prompt_cache_key = args.promptCacheKey;
  if (args.maxCompletionTokens) {
    body.max_completion_tokens = args.maxCompletionTokens;
  }

  const encoded = await encodeRequestPayload(body, args.payloadMode);

  const res = await fetch(`${CEREBRAS_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      ...encoded.headers,
      authorization: `Bearer ${args.apiKey}`,
    },
    body: encoded.body,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Cerebras chat completion failed (${res.status}): ${errText.slice(0, 500)}`,
    );
  }

  const json = (await res.json()) as CerebrasResponse;
  const choice = json.choices?.[0];
  if (!choice) throw new Error("Cerebras response had no choices");

  const rawResponseText = choice.message.content ?? "";
  const toolCalls = (choice.message.tool_calls ?? []).map((tc) => {
    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = JSON.parse(tc.function.arguments);
    } catch {
      parsedArgs = { _raw: tc.function.arguments };
    }
    return {
      id: tc.id,
      name: tc.function.name,
      args: parsedArgs,
    } satisfies ToolCallRecord;
  });

  const cached = json.usage?.prompt_tokens_details?.cached_tokens;
  const timeInfo = json.time_info ?? json.usage?.time_info;
  const usage: UsageBreakdown = {
    promptTokens: json.usage?.prompt_tokens ?? 0,
    completionTokens: json.usage?.completion_tokens ?? 0,
    cacheReadInputTokens: typeof cached === "number" ? cached : undefined,
    cachedTokens: typeof cached === "number" ? cached : undefined,
    cached_tokens: typeof cached === "number" ? cached : undefined,
    totalTokens:
      json.usage?.total_tokens ??
      (json.usage?.prompt_tokens ?? 0) + (json.usage?.completion_tokens ?? 0),
    timeInfo: timeInfo
      ? {
          queueTimeSec: timeInfo.queue_time,
          promptTimeSec: timeInfo.prompt_time,
          completionTimeSec: timeInfo.completion_time,
          totalTimeSec: timeInfo.total_time,
          created: timeInfo.created,
        }
      : undefined,
    raw: json.usage,
  };

  return {
    rawResponseText,
    toolCalls,
    finishReason: choice.finish_reason,
    usage,
    requestPayload: encoded.record,
  };
}

// ---------------------------------------------------------------------------
// Mock test actions (kept inline per spec — these exist only for this script)
// ---------------------------------------------------------------------------

interface MockAction {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{
    success: boolean;
    text?: string;
    data?: Record<string, unknown>;
    error?: string;
  }>;
}

const MOCK_ACTIONS: MockAction[] = [
  {
    name: "WEB_SEARCH",
    description:
      "Search the public web for the given query and return results.",
    parameters: {
      type: "object",
      properties: { q: { type: "string", description: "Search query" } },
      required: ["q"],
    },
    handler: async (a) => ({
      success: true,
      text: `Mocked search results for "${String(a.q ?? "")}".`,
      data: {
        results: [
          {
            title: "Eliza chatbot — Wikipedia",
            url: "https://en.wikipedia.org/wiki/ELIZA",
            snippet:
              "ELIZA is an early natural language processing computer program.",
          },
          {
            title: "elizaOS · GitHub",
            url: "https://github.com/elizaOS",
            snippet: "Open-source agentic runtime for AI assistants.",
          },
          {
            title: "Milady — local-first AI assistant",
            url: "https://milady.ai",
            snippet: "Built on elizaOS.",
          },
        ],
      },
    }),
  },
  {
    name: "CLIPBOARD_WRITE",
    description: "Save text content to a virtual in-memory clipboard.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["title", "content"],
    },
    handler: async (a) => ({
      success: true,
      text: `Saved "${String(a.title ?? "")}" to clipboard.`,
      data: { savedAt: Date.now() },
    }),
  },
  {
    name: "BROKEN_ACTION",
    description:
      "Test action that always fails. Used to exercise the evaluator's failure path.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string" } },
    },
    handler: async (a) => ({
      success: false,
      error: `Intentional failure: ${String(a.reason ?? "no reason given")}`,
    }),
  },
  {
    name: "REPLY",
    description: "Reply to the user with a final message.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    handler: async (a) => ({
      success: true,
      text: String(a.text ?? ""),
    }),
  },
  {
    name: "IGNORE",
    description: "Ignore the user's message and produce no response.",
    parameters: { type: "object", properties: {} },
    handler: async () => ({ success: true }),
  },
];

function actionByName(name: string): MockAction | undefined {
  return MOCK_ACTIONS.find((a) => a.name === name);
}

function toolDefsForCerebras(): CerebrasToolDef[] {
  return MOCK_ACTIONS.map((a) => ({
    type: "function",
    function: {
      name: a.name,
      description: a.description,
      parameters: a.parameters,
    },
  }));
}

const MESSAGE_HANDLER_RESPONSE_FORMAT: JsonSchemaResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "message_handler_decision",
    strict: true,
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["RESPOND", "IGNORE", "STOP"] },
        simple: { type: "boolean" },
        contexts: { type: "array", items: { type: "string" } },
        thought: { type: "string" },
        reply: { type: ["string", "null"] },
      },
      required: ["action", "simple", "contexts", "thought", "reply"],
      additionalProperties: false,
    },
  },
};

const EVALUATION_RESPONSE_FORMAT: JsonSchemaResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "tool_evaluation",
    strict: true,
    schema: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        decision: { type: "string", enum: ["FINISH", "CONTINUE"] },
        thought: { type: "string" },
        messageToUser: { type: ["string", "null"] },
      },
      required: ["success", "decision", "thought", "messageToUser"],
      additionalProperties: false,
    },
  },
};

const STANDALONE_AVAILABLE_CONTEXTS = [
  "- general: Normal conversation, public agent behavior, and direct replies.",
  "- web: Web search and reading public internet pages.",
  "- clipboard: Virtual clipboard writes used by the standalone Cerebras harness.",
].join("\n");

function promptHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function cacheRecordForPrompt(prompt: string): CacheStageRecord {
  return {
    segmentHashes: prompt
      .split(/\n\n+/)
      .filter((segment) => segment.trim().length > 0)
      .map(promptHash),
    prefixHash: promptHash(prompt),
  };
}

function renderSelectedContextEvidence(contexts: string[]): string {
  const selected = contexts.length > 0 ? contexts : ["general"];
  const providerRows = selected.map((context) => {
    const description =
      context === "web"
        ? "Mock web provider: exposes public search actions and mock search results."
        : context === "clipboard"
          ? "Mock clipboard provider: exposes virtual clipboard write state."
          : "General provider: direct conversation and final reply behavior.";
    return `- ${context}: ${description}`;
  });
  return [
    "selected_contexts:",
    ...selected.map((context) => `- ${context}`),
    "",
    "contextProviders:",
    ...providerRows,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Stage runners — minimal v5-shaped provider harness. This is intentionally
// not the full AgentRuntime path; it is a fast live-provider smoke test that
// emits the same recorded trajectory shape for review and dataset alignment.
// ---------------------------------------------------------------------------

interface RunOptions {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userMessage: string;
  promptCacheKey?: string;
  payloadMode: PayloadMode;
  maxCompletionTokens: number;
  noTty: boolean;
  stagesOnly: boolean;
  record: boolean;
  scenarioName?: string;
  runLabel?: string;
  runIndex?: number;
}

async function runMessageHandlerStage(args: {
  opts: RunOptions;
  recorder: LocalRecorder;
  stageNumber: number;
}): Promise<{
  action: "RESPOND" | "IGNORE" | "STOP";
  simple: boolean;
  contexts: string[];
  thought: string;
  reply?: string;
}> {
  const startedAt = Date.now();
  const messages: CerebrasChatMessage[] = [
    {
      role: "system",
      content:
        `${args.opts.systemPrompt}\n\nThis is the messageHandler stage. ` +
        `available_contexts:\n${STANDALONE_AVAILABLE_CONTEXTS}\n\n` +
        `Decide what to do with the user's message. Reply with strict JSON of the form ` +
        `{"action":"RESPOND"|"IGNORE"|"STOP","simple":bool,"contexts":string[],"thought":string,"reply":string|null}. ` +
        `Set simple:true and include reply only when no tool calls are needed; otherwise set reply:null.`,
    },
    { role: "user", content: args.opts.userMessage },
  ];

  const result = await cerebrasChat({
    apiKey: args.opts.apiKey,
    model: args.opts.model,
    messages,
    responseFormat: MESSAGE_HANDLER_RESPONSE_FORMAT,
    promptCacheKey: args.opts.promptCacheKey,
    payloadMode: args.opts.payloadMode,
    maxCompletionTokens: args.opts.maxCompletionTokens,
  });

  const endedAt = Date.now();
  const cost = computeCallCostUsd(args.opts.model, result.usage);
  let parsed: ReturnType<typeof tryParseMessageHandler>;
  try {
    parsed = tryParseMessageHandler(result.rawResponseText);
  } catch (err) {
    throw new Error(
      `messageHandler returned invalid JSON: ${(err as Error).message}\nraw: ${result.rawResponseText.slice(0, 200)}`,
    );
  }

  const prompt = messages.map((m) => `${m.role}: ${m.content}`).join("\n\n");
  args.recorder.record({
    stageId: `stage-${args.stageNumber}-msghandler`,
    kind: "messageHandler",
    startedAt,
    endedAt,
    latencyMs: endedAt - startedAt,
    model: {
      modelType: "RESPONSE_HANDLER",
      modelName: args.opts.model,
      provider: "cerebras",
      prompt,
      messages,
      tools: [],
      response: result.rawResponseText,
      toolCalls: [],
      usage: result.usage,
      cached_tokens: result.usage.cached_tokens,
      finishReason: result.finishReason,
      costUsd: cost,
      latencyMs: endedAt - startedAt,
      promptCacheKey: args.opts.promptCacheKey,
      requestPayload: result.requestPayload,
    },
    cache: cacheRecordForPrompt(prompt),
  });

  return parsed;
}

function tryParseMessageHandler(raw: string): {
  action: "RESPOND" | "IGNORE" | "STOP";
  simple: boolean;
  contexts: string[];
  thought: string;
  reply?: string;
} {
  const obj = JSON.parse(raw) as Record<string, unknown>;
  const action =
    typeof obj.action === "string" &&
    ["RESPOND", "IGNORE", "STOP"].includes(obj.action)
      ? (obj.action as "RESPOND" | "IGNORE" | "STOP")
      : "RESPOND";
  const simple = obj.simple === true;
  const contexts = Array.isArray(obj.contexts)
    ? obj.contexts.filter((x): x is string => typeof x === "string")
    : [];
  const thought = typeof obj.thought === "string" ? obj.thought : "";
  const reply = typeof obj.reply === "string" ? obj.reply : undefined;
  return { action, simple, contexts, thought, reply };
}

function messagesToPrompt(messages: CerebrasChatMessage[]): string {
  return messages
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n\n");
}

function withStageInstruction(
  conversation: CerebrasChatMessage[],
  instruction: string,
): CerebrasChatMessage[] {
  const [prefix, ...rest] = conversation;
  if (!prefix) return [{ role: "system", content: instruction }];
  return [
    prefix,
    {
      role: "system",
      content: instruction,
    },
    ...rest,
  ];
}

async function runPlannerIteration(args: {
  opts: RunOptions;
  recorder: LocalRecorder;
  iteration: number;
  systemPromptExtras: string;
  conversation: CerebrasChatMessage[];
}): Promise<{
  stageId: string;
  toolCalls: ToolCallRecord[];
  assistantText: string;
}> {
  const startedAt = Date.now();
  const plannerMessages = withStageInstruction(
    args.conversation,
    "This is the planner stage. Choose tool(s) to call. After each tool, you'll be re-prompted with the result.",
  );
  const result = await cerebrasChat({
    apiKey: args.opts.apiKey,
    model: args.opts.model,
    messages: plannerMessages,
    tools: toolDefsForCerebras(),
    toolChoice: "auto",
    promptCacheKey: args.opts.promptCacheKey,
    payloadMode: args.opts.payloadMode,
    maxCompletionTokens: args.opts.maxCompletionTokens,
  });
  const endedAt = Date.now();
  const cost = computeCallCostUsd(args.opts.model, result.usage);
  const stageId = `stage-${args.recorder.snapshot.stages.length + 1}-planner-iter-${args.iteration}`;
  const prompt = messagesToPrompt(plannerMessages);

  args.recorder.record({
    stageId,
    kind: "planner",
    iteration: args.iteration,
    startedAt,
    endedAt,
    latencyMs: endedAt - startedAt,
    model: {
      modelType: "ACTION_PLANNER",
      modelName: args.opts.model,
      provider: "cerebras",
      prompt,
      messages: plannerMessages,
      tools: toolDefsForCerebras().map((t) => ({
        name: t.function.name,
        description: t.function.description,
      })),
      toolChoice: "auto",
      response: result.rawResponseText,
      toolCalls: result.toolCalls,
      usage: result.usage,
      cached_tokens: result.usage.cached_tokens,
      finishReason: result.finishReason,
      costUsd: cost,
      latencyMs: endedAt - startedAt,
      promptCacheKey: args.opts.promptCacheKey,
      requestPayload: result.requestPayload,
    },
    cache: cacheRecordForPrompt(prompt),
  });

  void args.systemPromptExtras;
  return {
    stageId,
    toolCalls: result.toolCalls,
    assistantText: result.rawResponseText,
  };
}

async function runToolStage(args: {
  recorder: LocalRecorder;
  toolCall: ToolCallRecord;
}): Promise<{
  success: boolean;
  resultPayload: unknown;
  resultText: string;
}> {
  const startedAt = Date.now();
  const action = actionByName(args.toolCall.name ?? "");
  const argsObj = args.toolCall.args ?? {};

  let success = false;
  let resultPayload: unknown = null;
  let resultText = "";

  if (!action) {
    const err = `Unknown tool: ${args.toolCall.name}`;
    resultPayload = { success: false, error: err };
    resultText = err;
  } else {
    const out = await action.handler(argsObj);
    success = out.success;
    resultPayload = out;
    resultText = out.text ?? out.error ?? JSON.stringify(out);
  }

  const endedAt = Date.now();
  const stageNumber = args.recorder.snapshot.stages.length + 1;
  args.recorder.record({
    stageId: `stage-${stageNumber}-tool-${args.toolCall.name ?? "unknown"}`,
    kind: "tool",
    startedAt,
    endedAt,
    latencyMs: endedAt - startedAt,
    tool: {
      name: args.toolCall.name ?? "unknown",
      args: argsObj,
      result: resultPayload,
      success,
      durationMs: endedAt - startedAt,
    },
  });

  return { success, resultPayload, resultText };
}

async function runEvaluationStage(args: {
  opts: RunOptions;
  recorder: LocalRecorder;
  iteration: number;
  conversation: CerebrasChatMessage[];
}): Promise<EvaluationRecord> {
  const startedAt = Date.now();
  const evaluatorMessages = withStageInstruction(
    args.conversation,
    "You are the evaluator. Examine the most recent action result and reply with strict JSON: " +
      '{"success":bool,"decision":"FINISH"|"CONTINUE","thought":string,"messageToUser":string|null}. ' +
      "Mark success true only when every requested outcome is explicitly evidenced by completed tool results. " +
      "Never infer that a side effect happened unless a matching successful tool result exists. " +
      "If the user requested save/write/send/create/update/delete/payment/transfer and the only evidence is search/read/plan output, choose CONTINUE.",
  );

  const result = await cerebrasChat({
    apiKey: args.opts.apiKey,
    model: args.opts.model,
    messages: evaluatorMessages,
    responseFormat: EVALUATION_RESPONSE_FORMAT,
    promptCacheKey: args.opts.promptCacheKey,
    payloadMode: args.opts.payloadMode,
    maxCompletionTokens: args.opts.maxCompletionTokens,
  });
  const endedAt = Date.now();
  const cost = computeCallCostUsd(args.opts.model, result.usage);

  let evaluation: EvaluationRecord = {
    success: false,
    decision: "FINISH",
    thought: "Evaluator returned unparseable output; defaulting to FINISH.",
  };
  try {
    const parsed = JSON.parse(result.rawResponseText) as Record<
      string,
      unknown
    >;
    evaluation = {
      success: parsed.success === true,
      decision:
        typeof parsed.decision === "string" && parsed.decision === "CONTINUE"
          ? "CONTINUE"
          : "FINISH",
      thought: typeof parsed.thought === "string" ? parsed.thought : undefined,
      messageToUser:
        typeof parsed.messageToUser === "string"
          ? parsed.messageToUser
          : undefined,
    };
  } catch {
    // Falls through to default evaluation above.
  }

  const stageNumber = args.recorder.snapshot.stages.length + 1;
  const prompt = messagesToPrompt(evaluatorMessages);
  args.recorder.record({
    stageId: `stage-${stageNumber}-eval-iter-${args.iteration}`,
    kind: "evaluation",
    iteration: args.iteration,
    startedAt,
    endedAt,
    latencyMs: endedAt - startedAt,
    model: {
      modelType: "TEXT_LARGE",
      modelName: args.opts.model,
      provider: "cerebras",
      prompt,
      messages: evaluatorMessages,
      tools: [],
      response: result.rawResponseText,
      toolCalls: [],
      usage: result.usage,
      cached_tokens: result.usage.cached_tokens,
      finishReason: result.finishReason,
      costUsd: cost,
      latencyMs: endedAt - startedAt,
      promptCacheKey: args.opts.promptCacheKey,
      requestPayload: result.requestPayload,
    },
    evaluation,
    cache: cacheRecordForPrompt(prompt),
  });

  return evaluation;
}

// ---------------------------------------------------------------------------
// Top-level orchestration
// ---------------------------------------------------------------------------

const MAX_PLANNER_ITERATIONS = 4;

async function runTrajectory(opts: RunOptions): Promise<RecordedTrajectory> {
  const colors = colorize(opts.noTty);
  const printer = (stage: RecordedStage, idx: number): void => {
    const stamp = formatTimestamp(stage.startedAt);
    const lat = `${stage.latencyMs}ms`;
    const cost = stage.model?.costUsd
      ? ` · ${formatUsd(stage.model.costUsd)}`
      : "";
    const cache = stage.model?.usage?.cacheReadInputTokens
      ? ` (cache: ${stage.model.usage.cacheReadInputTokens} read)`
      : "";

    const headline = `[${stamp}] Stage ${idx + 1} [${stage.kind}${stage.iteration ? ` iter ${stage.iteration}` : ""}${stage.tool ? `: ${stage.tool.name}` : ""}] ${lat}${cost}${cache}`;
    console.log(colors.bold(headline));

    if (opts.stagesOnly) return;

    if (stage.model) {
      const u = stage.model.usage;
      if (u) {
        console.log(
          `  Prompt: ${u.promptTokens} tokens · Response: ${u.completionTokens} tokens · model ${stage.model.modelName ?? stage.model.modelType}`,
        );
      }
      if (stage.model.requestPayload) {
        const p = stage.model.requestPayload;
        console.log(
          `  Payload: ${p.mode} · ${p.encodedBytes}/${p.uncompressedBytes} bytes (${p.compressionRatio.toFixed(2)}x)`,
        );
      }
      if (stage.model.toolCalls && stage.model.toolCalls.length > 0) {
        console.log(
          `  → toolCalls: [${stage.model.toolCalls.map((tc) => `${tc.name}(${JSON.stringify(tc.args ?? {})})`).join(", ")}]`,
        );
      }
    }
    if (stage.tool) {
      const status = stage.tool.success
        ? colors.green("success: true")
        : colors.red("success: false");
      console.log(`  → ${status}`);
    }
    if (stage.evaluation) {
      const status = stage.evaluation.success
        ? colors.green("success: true")
        : colors.red("success: false");
      console.log(
        `  → ${status}, decision: ${colors.cyan(stage.evaluation.decision)}`,
      );
      if (stage.evaluation.thought) {
        console.log(`  → thought: ${stage.evaluation.thought}`);
      }
      if (stage.evaluation.messageToUser) {
        console.log(`  → messageToUser: ${stage.evaluation.messageToUser}`);
      }
    }
  };

  const recorder = new LocalRecorder({
    agentId: "agent-cerebras-runner",
    roomId: "room-cerebras-runner",
    rootMessage: {
      id: `msg-${Date.now()}`,
      text: opts.userMessage,
      sender: "user",
    },
    metadata: {
      model: opts.model,
      scenarioName: opts.scenarioName,
      runLabel: opts.runLabel,
      runIndex: opts.runIndex,
      payloadMode: opts.payloadMode,
      promptCacheKey: opts.promptCacheKey,
      maxCompletionTokens: opts.maxCompletionTokens,
    },
    printer,
  });

  console.log(
    colors.bold(
      `[${formatTimestamp(Date.now())}] Trajectory ${recorder.id} started`,
    ),
  );
  if (opts.scenarioName) {
    console.log(colors.dim(`  scenario: ${opts.scenarioName}`));
  }
  if (opts.runLabel) {
    console.log(colors.dim(`  run: ${opts.runLabel}`));
  }
  if (opts.promptCacheKey) {
    console.log(colors.dim(`  prompt_cache_key: ${opts.promptCacheKey}`));
  }
  console.log(colors.dim(`  payload: ${opts.payloadMode}`));
  console.log(colors.dim(`  message: ${opts.userMessage}`));

  try {
    // Stage 1: messageHandler
    const handler = await runMessageHandlerStage({
      opts,
      recorder,
      stageNumber: 1,
    });

    if (handler.action === "IGNORE" || handler.action === "STOP") {
      recorder.snapshot.metrics.finalDecision = "FINISH";
      console.log(colors.dim(`  messageHandler returned ${handler.action}.`));
    } else if (handler.simple && handler.reply) {
      recorder.snapshot.metrics.finalDecision = "FINISH";
      console.log(colors.dim(`  direct reply: ${handler.reply}`));
    } else {
      // Planner / tool / evaluator loop
      const conversation: CerebrasChatMessage[] = [
        {
          role: "system",
          content:
            `${opts.systemPrompt}\n\n` +
            renderSelectedContextEvidence(handler.contexts),
        },
        { role: "user", content: opts.userMessage },
      ];

      let iteration = 1;
      while (iteration <= MAX_PLANNER_ITERATIONS) {
        const plannerResult = await runPlannerIteration({
          opts,
          recorder,
          iteration,
          systemPromptExtras: "",
          conversation,
        });

        if (plannerResult.toolCalls.length === 0) {
          // No more tool calls — treat assistant text as the final answer.
          if (plannerResult.assistantText) {
            console.log(
              colors.dim(
                `  final assistant message: ${plannerResult.assistantText}`,
              ),
            );
          }
          recorder.snapshot.metrics.finalDecision = "FINISH";
          break;
        }

        // Append the assistant tool-call message to the conversation
        conversation.push({
          role: "assistant",
          content: plannerResult.assistantText,
          tool_calls: plannerResult.toolCalls.map((tc) => ({
            id: tc.id ?? `tc-${crypto.randomBytes(3).toString("hex")}`,
            type: "function" as const,
            function: {
              name: tc.name ?? "unknown",
              arguments: JSON.stringify(tc.args ?? {}),
            },
          })),
        });

        // Execute every returned tool call sequentially
        let anyFailure = false;
        for (const toolCall of plannerResult.toolCalls) {
          const exec = await runToolStage({ recorder, toolCall });
          if (!exec.success) anyFailure = true;
          conversation.push({
            role: "tool",
            content:
              typeof exec.resultPayload === "string"
                ? exec.resultPayload
                : JSON.stringify(exec.resultPayload),
            tool_call_id: toolCall.id,
            name: toolCall.name,
          });
        }

        const evaluation = await runEvaluationStage({
          opts,
          recorder,
          iteration,
          conversation,
        });
        conversation.push({
          role: "system",
          content: `evaluation_result:\n${JSON.stringify({
            success: evaluation.success,
            decision: evaluation.decision,
            thought: evaluation.thought ?? null,
            messageToUser: evaluation.messageToUser ?? null,
          })}`,
        });

        if (evaluation.decision === "FINISH") {
          recorder.snapshot.metrics.finalDecision = "FINISH";
          if (evaluation.messageToUser) {
            console.log(
              colors.dim(`  final messageToUser: ${evaluation.messageToUser}`),
            );
          }
          break;
        }

        recorder.snapshot.metrics.finalDecision = "CONTINUE";
        if (anyFailure) {
          console.log(
            colors.dim("  evaluator requested CONTINUE after a tool failure."),
          );
        }
        iteration += 1;
      }

      if (iteration > MAX_PLANNER_ITERATIONS) {
        recorder.snapshot.metrics.finalDecision = "max_iterations";
      }
    }

    const final = recorder.end("finished");
    console.log("");
    console.log(
      colors.bold(
        `[${formatTimestamp(Date.now())}] Trajectory finished: ${final.metrics.totalLatencyMs}ms · ${formatUsd(final.metrics.totalCostUsd)} · ${final.stages.length} stages · ${final.metrics.toolCallsExecuted} tool calls (${final.metrics.toolCallsExecuted - final.metrics.toolCallFailures} success)`,
      ),
    );
    const cacheRate =
      final.metrics.totalPromptTokens > 0
        ? (final.metrics.totalCacheReadTokens /
            final.metrics.totalPromptTokens) *
          100
        : 0;
    console.log(
      colors.dim(`  cache hit rate: ${cacheRate.toFixed(1)}% across stages`),
    );
    return final;
  } catch (err) {
    recorder.end("errored");
    console.error(
      colors.red(
        `Trajectory ${recorder.id} errored: ${(err as Error).message}`,
      ),
    );
    throw err;
  }
}

export function deriveTerminalDecision(
  trajectory: Pick<RecordedTrajectory, "status" | "stages" | "metrics">,
): TrajectoryMetrics["finalDecision"] {
  if (trajectory.status === "errored") return "error";
  const stages = trajectory.stages ?? [];
  const lastStage = stages[stages.length - 1];
  if (!lastStage) return trajectory.metrics.finalDecision;
  if (trajectory.metrics.finalDecision === "max_iterations")
    return "max_iterations";
  if (lastStage.evaluation?.decision) {
    return lastStage.evaluation.decision as TrajectoryMetrics["finalDecision"];
  }
  return trajectory.metrics.finalDecision;
}

export function validateTerminalDecision(
  trajectory: RecordedTrajectory,
): string[] {
  const expected = deriveTerminalDecision(trajectory);
  const actual = trajectory.metrics.finalDecision;
  if (expected && actual !== expected) {
    return [
      `metrics.finalDecision=${String(actual)} does not match terminal stage decision ${String(expected)}`,
    ];
  }
  return [];
}

async function saveTrajectory(
  trajectory: RecordedTrajectory,
  targetDir: string,
): Promise<string> {
  await fs.mkdir(targetDir, { recursive: true });
  const filePath = path.join(targetDir, `${trajectory.trajectoryId}.json`);
  await fs.writeFile(filePath, JSON.stringify(trajectory, null, 2), "utf8");
  return filePath;
}

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq >= 0) {
        flags.set(token.slice(2, eq), token.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags.set(token.slice(2), next);
          i++;
        } else {
          flags.set(token.slice(2), true);
        }
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

// ---------------------------------------------------------------------------
// Scenario loading
// ---------------------------------------------------------------------------

interface ScenarioFile {
  message: string;
  systemPrompt?: string;
  expect?: Record<string, unknown>;
}

async function loadScenario(name: string): Promise<ScenarioFile> {
  const candidate = path.resolve(
    process.cwd(),
    "research/native-tool-calling/scenarios",
    `${name.replace(/\.json$/, "")}.json`,
  );
  const raw = await fs.readFile(candidate, "utf8");
  return JSON.parse(raw) as ScenarioFile;
}

async function listScenarioNames(): Promise<string[]> {
  const dir = path.resolve(
    process.cwd(),
    "research/native-tool-calling/scenarios",
  );
  const entries = await fs.readdir(dir);
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.replace(/\.json$/, ""))
    .sort();
}

function parsePositiveIntFlag(
  flags: Map<string, string | true>,
  name: string,
  defaultValue: number,
): number {
  const raw = flags.get(name);
  if (raw === undefined || raw === true) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function parsePayloadMode(raw: string | true | undefined): PayloadMode {
  if (raw === undefined || raw === true) return "json";
  if (
    raw === "json" ||
    raw === "gzip" ||
    raw === "msgpack" ||
    raw === "msgpack-gzip"
  ) {
    return raw;
  }
  throw new Error(
    `--payload must be one of json, gzip, msgpack, msgpack-gzip; got ${String(raw)}`,
  );
}

function stablePromptCacheKey(args: {
  explicit?: string;
  systemPrompt: string;
  scenarioName?: string;
  userMessage: string;
  payloadMode: PayloadMode;
}): string | undefined {
  if (args.explicit !== undefined) {
    if (args.explicit.length > 1024) {
      throw new Error("--prompt-cache-key must be 1024 characters or fewer");
    }
    return args.explicit;
  }
  if (!args.scenarioName) return undefined;
  const staticHash = crypto
    .createHash("sha256")
    .update(args.systemPrompt)
    .update(JSON.stringify(toolDefsForCerebras()))
    .digest("hex")
    .slice(0, 16);
  return `run-cerebras:${args.scenarioName}:${args.payloadMode}:${staticHash}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const DEFAULT_SYSTEM_PROMPT =
  "You are a concise test agent. Use the provided tools when they are useful. " +
  "Always reply with strictly valid JSON when the message you are answering asks for it.";

interface RunExport {
  trajectory: RecordedTrajectory;
  path?: string;
  validationErrors: string[];
}

async function runAndMaybeSave(
  opts: RunOptions,
  targetDir: string,
): Promise<RunExport> {
  const trajectory = await runTrajectory(opts);
  const validationErrors = validateTerminalDecision(trajectory);
  if (validationErrors.length > 0) {
    throw new Error(validationErrors.join("; "));
  }

  let filePath: string | undefined;
  if (opts.record) {
    filePath = await saveTrajectory(trajectory, targetDir);
    console.log(`Exported trajectory: ${filePath}`);
    console.log(
      `Inspect: bun run scripts/trajectory.ts print ${trajectory.trajectoryId}`,
    );
  }
  return { trajectory, path: filePath, validationErrors };
}

async function runBatchingComparison(args: {
  baseOpts: RunOptions;
  scenarioNames: string[];
  targetDir: string;
}): Promise<string> {
  const startedAt = Date.now();
  const serial: RunExport[] = [];

  console.log(
    `Comparing serial vs concurrent batch-style runs for scenarios: ${args.scenarioNames.join(", ")}`,
  );

  const serialStarted = Date.now();
  for (const scenarioName of args.scenarioNames) {
    const scenario = await loadScenario(scenarioName);
    const promptCacheKey = stablePromptCacheKey({
      explicit: args.baseOpts.promptCacheKey,
      systemPrompt: scenario.systemPrompt ?? args.baseOpts.systemPrompt,
      scenarioName,
      userMessage: scenario.message,
      payloadMode: args.baseOpts.payloadMode,
    });
    serial.push(
      await runAndMaybeSave(
        {
          ...args.baseOpts,
          systemPrompt: scenario.systemPrompt ?? args.baseOpts.systemPrompt,
          userMessage: scenario.message,
          scenarioName,
          promptCacheKey,
          runLabel: "serial",
        },
        args.targetDir,
      ),
    );
  }
  const serialEnded = Date.now();

  const concurrentStarted = Date.now();
  const concurrent = await Promise.all(
    args.scenarioNames.map(async (scenarioName, index) => {
      const scenario = await loadScenario(scenarioName);
      const promptCacheKey = stablePromptCacheKey({
        explicit: args.baseOpts.promptCacheKey,
        systemPrompt: scenario.systemPrompt ?? args.baseOpts.systemPrompt,
        scenarioName,
        userMessage: scenario.message,
        payloadMode: args.baseOpts.payloadMode,
      });
      return runAndMaybeSave(
        {
          ...args.baseOpts,
          systemPrompt: scenario.systemPrompt ?? args.baseOpts.systemPrompt,
          userMessage: scenario.message,
          scenarioName,
          promptCacheKey,
          runLabel: "concurrent-batch",
          runIndex: index + 1,
        },
        args.targetDir,
      );
    }),
  );
  const concurrentEnded = Date.now();

  const comparison = {
    kind: "cerebras-batching-comparison",
    startedAt,
    endedAt: Date.now(),
    model: args.baseOpts.model,
    payloadMode: args.baseOpts.payloadMode,
    scenarioNames: args.scenarioNames,
    serial: {
      wallLatencyMs: serialEnded - serialStarted,
      trajectoryIds: serial.map((r) => r.trajectory.trajectoryId),
      paths: serial.map((r) => r.path).filter(Boolean),
      totalCostUsd: serial.reduce(
        (sum, r) => sum + r.trajectory.metrics.totalCostUsd,
        0,
      ),
      totalCacheReadTokens: serial.reduce(
        (sum, r) => sum + r.trajectory.metrics.totalCacheReadTokens,
        0,
      ),
    },
    concurrentBatchEquivalent: {
      wallLatencyMs: concurrentEnded - concurrentStarted,
      trajectoryIds: concurrent.map((r) => r.trajectory.trajectoryId),
      paths: concurrent.map((r) => r.path).filter(Boolean),
      totalCostUsd: concurrent.reduce(
        (sum, r) => sum + r.trajectory.metrics.totalCostUsd,
        0,
      ),
      totalCacheReadTokens: concurrent.reduce(
        (sum, r) => sum + r.trajectory.metrics.totalCacheReadTokens,
        0,
      ),
    },
  };

  await fs.mkdir(args.targetDir, { recursive: true });
  const filePath = path.join(
    args.targetDir,
    `cerebras-batching-comparison-${startedAt}.json`,
  );
  await fs.writeFile(filePath, JSON.stringify(comparison, null, 2), "utf8");
  console.log(`Exported batching comparison: ${filePath}`);
  return filePath;
}

async function main(): Promise<void> {
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    console.error(
      "CEREBRAS_API_KEY is not set. Export it in your shell before running this script.",
    );
    process.exit(1);
  }

  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const payloadMode = parsePayloadMode(flags.get("payload"));
  const repeat = parsePositiveIntFlag(flags, "repeat", 1);
  const maxCompletionTokens = parsePositiveIntFlag(
    flags,
    "max-completion-tokens",
    512,
  );

  let userMessage =
    (flags.get("message") as string | undefined) ?? positional[0];
  let systemPrompt = DEFAULT_SYSTEM_PROMPT;
  let scenarioName: string | undefined;

  const scenarioFlag = flags.get("scenario");
  if (typeof scenarioFlag === "string") {
    scenarioName = scenarioFlag;
    try {
      const scenario = await loadScenario(scenarioFlag);
      userMessage = scenario.message;
      if (scenario.systemPrompt) systemPrompt = scenario.systemPrompt;
    } catch (err) {
      console.error(
        `Failed to load scenario "${scenarioFlag}": ${(err as Error).message}`,
      );
      process.exit(1);
    }
  }

  const targetDir =
    process.env.MILADY_TRAJECTORY_DIR ??
    path.resolve(process.cwd(), "trajectories");

  const compareBatching =
    flags.get("compare-batching") === true ||
    flags.get("compare-batching") === "true";

  if (!userMessage && !compareBatching) {
    console.error(
      'No message provided. Pass a positional arg, --message "...", or --scenario <name>.',
    );
    process.exit(1);
  }

  const rawPromptCacheKey = flags.get("prompt-cache-key");
  if (rawPromptCacheKey === true) {
    throw new Error("--prompt-cache-key requires a string value");
  }
  const promptCacheKey = stablePromptCacheKey({
    explicit: rawPromptCacheKey,
    systemPrompt,
    scenarioName,
    userMessage: userMessage ?? "",
    payloadMode,
  });

  const opts: RunOptions = {
    apiKey,
    model: (flags.get("model") as string | undefined) ?? "gpt-oss-120b",
    systemPrompt,
    userMessage: userMessage ?? "",
    promptCacheKey,
    payloadMode,
    maxCompletionTokens,
    noTty: flags.get("no-tty") === true || flags.get("no-tty") === "true",
    stagesOnly:
      flags.get("stages-only") === true || flags.get("stages-only") === "true",
    record: !(
      flags.get("no-record") === true || flags.get("no-record") === "true"
    ),
    scenarioName,
  };

  if (compareBatching) {
    const rawScenarios = flags.get("scenarios");
    const scenarioNames =
      typeof rawScenarios === "string"
        ? rawScenarios
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : scenarioName
          ? [scenarioName]
          : await listScenarioNames();
    if (scenarioNames.length === 0) {
      throw new Error("--compare-batching found no scenarios to run");
    }
    await runBatchingComparison({ baseOpts: opts, scenarioNames, targetDir });
    return;
  }

  for (let i = 1; i <= repeat; i++) {
    await runAndMaybeSave(
      {
        ...opts,
        runLabel: repeat > 1 ? `repeat-${i}-of-${repeat}` : undefined,
        runIndex: repeat > 1 ? i : undefined,
      },
      targetDir,
    );
  }
}

if (import.meta.main) {
  main().catch((err) => {
    if (err instanceof GracefulSkip) {
      console.warn(`run-cerebras skipped: ${err.message}`);
      process.exit(0);
    }
    console.error(`run-cerebras failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
