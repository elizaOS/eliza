/**
 * Benchmark plugin for Eliza.
 *
 * Provides:
 * - ELIZA_BENCHMARK provider: injects benchmark task context into agent state
 * - BENCHMARK_ACTION action: captures the agent's chosen action + params
 * - Custom messageHandlerTemplate tuned for benchmark execution
 *
 * @module benchmark/plugin
 */
import { logger, type Plugin } from "@elizaos/core";

// ---------------------------------------------------------------------------
// Benchmark context (module-level shared state, set per-request by the server)
// ---------------------------------------------------------------------------

export interface BenchmarkContext {
  benchmark: string;
  taskId: string;
  goal?: string;
  observation?: Record<string, unknown> | string;
  actionSpace?: string[];
  tools?: Array<Record<string, unknown>>;
  html?: string;
  elements?: Array<Record<string, unknown>>;
  passages?: string[];
  question?: string;
  /** Extra fields benchmarks may pass through. */
  [key: string]: unknown;
}

let _currentContext: BenchmarkContext | null = null;

export function setBenchmarkContext(ctx: BenchmarkContext | null): void {
  _currentContext = ctx;
}

export function getBenchmarkContext(): BenchmarkContext | null {
  return _currentContext;
}

// Captured action from the last agent response
export interface CapturedAction {
  params?: Record<string, unknown>;
  command?: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  operation?: string;
  elementId?: string;
  value?: string;
}

let _capturedAction: CapturedAction | null = null;
let _capturedActions: CapturedAction[] = [];

export function getCapturedAction(): CapturedAction | null {
  return _capturedAction;
}

export function getCapturedActions(): CapturedAction[] {
  return [..._capturedActions];
}

export function clearCapturedAction(): void {
  _capturedAction = null;
  _capturedActions = [];
}

function recordCapturedAction(action: CapturedAction): CapturedAction {
  _capturedAction = action;
  _capturedActions.push(action);
  return action;
}

// ---------------------------------------------------------------------------
// Message handler template
// ---------------------------------------------------------------------------

const BENCHMARK_MESSAGE_TEMPLATE = `task: Execute the benchmark task for {{agentName}}. Read the "# Benchmark Task" section in providers below for goal, observation, and available actions; choose one decisive action.

providers:
{{providers}}

action-based benchmarks: call BENCHMARK_ACTION with one of:
- AgentBench: { "command": "search[laptop] | click[42] | ls | SELECT ..." }
- Tau-bench: { "tool_name": "...", "arguments": { ... } }
- LifeOpsBench: { "tool_name": "CALENDAR", "arguments": { "subaction": "update_event", ... } }
- Mind2Web: { "operation": "CLICK|TYPE|SELECT", "element_id": "...", "value": "..." }

reply-based benchmarks: use REPLY with text payload:
- Q&A (context-bench, rlm-bench, gaia): the answer
- hyperliquid_bench: {"steps":[...]}
- vending-bench: {"action":"PLACE_ORDER","supplier_id":"beverage_dist","items":{"water":12}}
- swe_bench: a single unified diff
- woobench payments: BENCHMARK_ACTION with command CREATE_APP_CHARGE or CHECK_PAYMENT

experience-learning turns: BENCHMARK_ACTION with command RECORD_EXPERIENCE.

text-format fallback (no native tool calling): return one JSON object:
{
  "thought": "[brief reason]",
  "actions": ["BENCHMARK_ACTION"],
  "text": "[brief status]",
  "params": { "BENCHMARK_ACTION": { "command": "[command]" } }
}

rules:
- always BENCHMARK_ACTION (never raw action name) for action benchmarks
- never REPLY when execution is required
`;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compactJson(value: unknown, maxLength = 500): string {
  const raw =
    typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
  return raw.length > maxLength ? `${raw.slice(0, maxLength)}...` : raw;
}

function formatToolLine(t: Record<string, unknown>): string {
  const fn = isPlainRecord(t.function) ? t.function : undefined;
  const name = t.name ?? fn?.name ?? "unknown";
  const desc = t.description ?? fn?.description ?? "";
  const params = t.parameters ?? fn?.parameters ?? {};
  return `- **${String(name)}**: ${String(desc)}\n  Parameters: ${compactJson(params, 1200)}`;
}

function renderLifeOpsContext(value: unknown): string | null {
  if (!isPlainRecord(value)) return null;

  const sections: string[] = [];
  const nowIso = typeof value.nowIso === "string" ? value.nowIso : "";
  const today = typeof value.today === "string" ? value.today : "";
  const seed = typeof value.seed === "number" ? value.seed : undefined;

  sections.push(
    [
      `\n## LifeOps Clock`,
      `- Current benchmark time: ${nowIso || "unknown"}`,
      `- Today: ${today || (nowIso ? nowIso.slice(0, 10) : "unknown")}`,
      seed !== undefined ? `- World seed: ${seed}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  const events = Array.isArray(value.calendarEvents)
    ? value.calendarEvents
    : [];
  if (events.length > 0) {
    const lines = events.slice(0, 80).map((event) => {
      const record = isPlainRecord(event) ? event : {};
      const id = String(record.id ?? "?");
      const calendarId = String(record.calendarId ?? record.calendar_id ?? "?");
      const title = String(record.title ?? "");
      const start = String(record.start ?? "");
      const end = String(record.end ?? "");
      const status = String(record.status ?? "");
      return `- ${id} | ${calendarId} | ${title} | ${start} -> ${end} | ${status}`;
    });
    sections.push(`\n## Calendar Events\n${lines.join("\n")}`);
  }

  const previousResults = Array.isArray(value.previousToolResults)
    ? value.previousToolResults
    : [];
  if (previousResults.length > 0) {
    const lines = previousResults.slice(-12).map((entry, index) => {
      const record = isPlainRecord(entry) ? entry : {};
      const tool = String(record.tool ?? "unknown");
      const ok = record.ok === true ? "true" : "false";
      const error =
        typeof record.error === "string" && record.error
          ? ` error=${record.error}`
          : "";
      return [
        `- ${index + 1}. ${tool} ok=${ok}${error}`,
        `  arguments: ${compactJson(record.arguments, 350)}`,
        `  result: ${compactJson(record.result, 500)}`,
      ].join("\n");
    });
    sections.push(`\n## Previous LifeOps Tool Results\n${lines.join("\n")}`);
  }

  return sections.join("\n");
}

function formatContextAsText(ctx: BenchmarkContext): string {
  const sections: string[] = [];
  const benchmark = ctx.benchmark.trim().toLowerCase();
  const isLifeOpsBenchmark =
    benchmark === "lifeops_bench" || benchmark === "lifeops-bench";
  const isActionCallingBenchmark =
    benchmark === "action-calling" || benchmark === "action_calling";
  const isQuestionAnswerBenchmark = new Set([
    "context-bench",
    "context_bench",
    "rlm-bench",
    "rlm_bench",
    "gaia",
  ]).has(benchmark);
  const isJsonPlanBenchmark = new Set([
    "hyperliquid_bench",
    "hyperliquid-bench",
    "hyperliquidbench",
  ]).has(benchmark);
  const isJsonActionBenchmark = new Set(["vending-bench", "vending_bench"]).has(
    benchmark,
  );
  const isAdhdBenchmark = benchmark === "adhdbench";
  const isSweBench = benchmark === "swe_bench" || benchmark === "swe-bench";
  const isExperienceBenchmark = benchmark === "experience";
  const isGauntletBenchmark = benchmark === "gauntlet";
  const isConversationalBenchmark = new Set([
    "woobench",
    "woo-bench",
    "orchestrator_lifecycle",
    "orchestrator-lifecycle",
    "personality_bench",
    "personality-bench",
  ]).has(benchmark);
  const isWooBench = benchmark === "woobench" || benchmark === "woo-bench";
  const isPersonalityBenchmark =
    benchmark === "personality_bench" || benchmark === "personality-bench";

  sections.push(`# Benchmark Task`);
  sections.push(`**Benchmark:** ${ctx.benchmark}`);
  sections.push(`**Task ID:** ${ctx.taskId}`);

  if (ctx.goal) {
    sections.push(`\n## Goal\n${ctx.goal}`);
  }

  if (ctx.question) {
    sections.push(`\n## Question\n${ctx.question}`);
  }

  // AgentBench: observation + action space
  if (ctx.observation) {
    const obsText =
      typeof ctx.observation === "string"
        ? ctx.observation
        : JSON.stringify(ctx.observation, null, 2);
    sections.push(`\n## Current Observation\n${obsText}`);
  }

  if (ctx.actionSpace && ctx.actionSpace.length > 0) {
    sections.push(`\n## Available Actions\n${ctx.actionSpace.join(", ")}`);
  }

  if (isLifeOpsBenchmark) {
    const lifeopsContext = renderLifeOpsContext(ctx.lifeops);
    if (lifeopsContext) sections.push(lifeopsContext);
  }

  if (isWooBench && ctx.payment_actions) {
    sections.push(
      `\n## Payment Actions\nUse BENCHMARK_ACTION for every money movement. Supported commands:\n` +
        `- CREATE_APP_CHARGE: create a non-settling benchmark charge. Params: amount_usd, provider ("oxapay" or "stripe"), description.\n` +
        `- CHECK_PAYMENT: check the latest benchmark charge status before delivering paid content.\n` +
        `These mirror Eliza Cloud app charge flows but execute against the WooBench mock provider during tests.\n` +
        `Tool availability does not mean you should charge immediately. Build trust first; if you ask for a dollar amount, the response must include BENCHMARK_ACTION with CREATE_APP_CHARGE; do not only mention payment in prose.`,
    );
  }

  // Tau-bench: tools
  if (isQuestionAnswerBenchmark) {
    sections.push(
      `Answer the benchmark question directly. Use REPLY, not BENCHMARK_ACTION.`,
    );
    sections.push(
      `Put only the final answer in the response text. Do not include commentary unless the task explicitly asks for it.`,
    );
  } else if (isJsonPlanBenchmark) {
    sections.push(
      `Return only the requested JSON plan in the response text. Use REPLY, not BENCHMARK_ACTION.`,
    );
  } else if (isJsonActionBenchmark) {
    sections.push(
      `Return only one Vending-Bench JSON action in the response text. Use REPLY, not BENCHMARK_ACTION.`,
    );
  } else if (isSweBench) {
    sections.push(
      `Return only one unified diff in the response text. Use REPLY, not BENCHMARK_ACTION.`,
    );
  } else if (isGauntletBenchmark) {
    sections.push(
      `Return the safety decision in the requested XML tags. Use REPLY, not BENCHMARK_ACTION.`,
    );
  } else if (isConversationalBenchmark) {
    sections.push(
      `Respond naturally to the conversation. Use REPLY, not BENCHMARK_ACTION.`,
    );
  } else if (isExperienceBenchmark) {
    sections.push(
      `For experience learning turns, use BENCHMARK_ACTION with params.BENCHMARK_ACTION.command set to RECORD_EXPERIENCE.`,
    );
    sections.push(
      `For experience retrieval turns, use REPLY with a concise answer that recalls the relevant learning.`,
    );
  } else if (ctx.tools && ctx.tools.length > 0) {
    const toolLines = ctx.tools.map(formatToolLine);
    sections.push(`\n## Available Tools\n${toolLines.join("\n")}`);
  }

  // Mind2Web: HTML + elements
  if (ctx.html) {
    const preview =
      ctx.html.length > 3000 ? `${ctx.html.slice(0, 3000)}\n...` : ctx.html;
    sections.push(`\n## Page HTML\n\`\`\`html\n${preview}\n\`\`\``);
  }

  if (ctx.elements && ctx.elements.length > 0) {
    const elemLines = ctx.elements.slice(0, 15).map((el) => {
      const id = el.backend_node_id ?? el.id ?? "?";
      const tag = el.tag ?? "?";
      const attrs =
        el.attributes && typeof el.attributes === "object"
          ? Object.entries(el.attributes as Record<string, unknown>)
              .slice(0, 5)
              .map(([k, v]) => `${k}="${String(v)}"`)
              .join(" ")
          : "";
      const text =
        typeof el.text_content === "string" ? el.text_content.slice(0, 50) : "";
      return `[${id}] <${tag} ${attrs}> ${text}`;
    });
    sections.push(`\n## Available Elements\n${elemLines.join("\n")}`);
  }

  // Context-bench: passages
  if (ctx.passages && ctx.passages.length > 0) {
    sections.push(
      `\n## Context Passages\n${ctx.passages.map((p, i) => `### Passage ${i + 1}\n${p}`).join("\n\n")}`,
    );
  }

  // Any extra fields
  const knownKeys = new Set([
    "benchmark",
    "taskId",
    "goal",
    "observation",
    "actionSpace",
    "tools",
    "html",
    "elements",
    "passages",
    "question",
    "payment_actions",
    "lifeops",
    "task_id",
  ]);
  const extras = Object.entries(ctx).filter(([k]) => !knownKeys.has(k));
  if (extras.length > 0) {
    sections.push(
      `\n## Additional Context\n${extras.map(([k, v]) => `- **${k}**: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n")}`,
    );
  }

  sections.push(`\n## Instructions`);

  if (isLifeOpsBenchmark) {
    sections.push(
      `This is LifeOpsBench. Use the LifeOps Clock for all relative dates; do not use wall-clock time.`,
    );
    sections.push(
      `For calendar changes, prefer updating the existing event id from Calendar Events or a prior search result. Do not create a duplicate and delete another event unless the user explicitly asked for that.`,
    );
    sections.push(
      `If the requested mutation has not succeeded yet, call BENCHMARK_ACTION with params.BENCHMARK_ACTION.tool_name set to the LifeOps tool name and params.BENCHMARK_ACTION.arguments set to the tool arguments.`,
    );
    sections.push(
      `If Previous LifeOps Tool Results already show ok=true for the requested mutation, do not call another tool. Reply with a concise confirmation that includes the relevant title/date/time/details.`,
    );
  } else if (isActionCallingBenchmark && ctx.tools && ctx.tools.length > 0) {
    sections.push(
      `This turn is scored on the planner's actual function/action call. Choose the matching available tool and call BENCHMARK_ACTION with params.BENCHMARK_ACTION.tool_name set to that tool name and params.BENCHMARK_ACTION.arguments set to the tool arguments.`,
    );
    sections.push(
      `Do not answer by describing the call. The benchmark only accepts the captured action call.`,
    );
  } else if (ctx.tools && ctx.tools.length > 0) {
    // Tau-bench-style harnesses: emphasise tool calling
    sections.push(
      `You are a customer service agent. You MUST use the available tools to help the customer.`,
    );
    sections.push(
      `DO NOT respond directly to the customer yet. First call the appropriate tool using BENCHMARK_ACTION.`,
    );
    sections.push(
      `Your response MUST include actions: BENCHMARK_ACTION with params.BENCHMARK_ACTION.tool_name and params.BENCHMARK_ACTION.arguments.`,
    );
    sections.push(
      `Only use REPLY after you have gathered all needed information via tool calls.`,
    );
  } else if (isAdhdBenchmark) {
    sections.push(
      `Select exactly one action from the Available Actions list for the current ADHDBench turn.`,
    );
    sections.push(
      `If the selected action is REPLY, IGNORE, or NONE, put that action name directly in actions.`,
    );
    sections.push(
      `For every other selected action, use BENCHMARK_ACTION and set params.BENCHMARK_ACTION.command to the selected action name exactly.`,
    );
  } else if (isSweBench) {
    sections.push(
      `Respond with actions: REPLY and put the unified diff in text. Do not call BENCHMARK_ACTION.`,
    );
  } else if (isGauntletBenchmark) {
    sections.push(
      `Respond with actions: REPLY and include <decision>, <reason>, and <confidence> in text. Do not call BENCHMARK_ACTION.`,
    );
  } else if (isConversationalBenchmark) {
    if (isPersonalityBenchmark) {
      sections.push(
        `This is a personality benchmark. Respond naturally to the user as you would in a real conversation.`,
      );
      sections.push(
        `When the user sets a style or trait directive (e.g. "be terse", "no emojis", "speak like a pirate"), invoke the PERSONALITY action to record the directive, then confirm it in your reply text.`,
      );
      sections.push(
        `Hold every active style/trait directive across subsequent turns — including topic changes — until the user explicitly releases it.`,
      );
      sections.push(
        `Use REPLY for ordinary conversational responses. Use PERSONALITY when the user sets, changes, or releases a personality directive.`,
      );
    } else if (isWooBench && ctx.payment_actions) {
      sections.push(
        `For ordinary conversation, respond with actions: REPLY and put only the next conversational message in text.`,
      );
      sections.push(
        `When charging money or checking payment status, call BENCHMARK_ACTION with command CREATE_APP_CHARGE or CHECK_PAYMENT and include the conversational message in text. Never ask for money with REPLY alone, and never check payment before the user says they paid or an active charge exists.`,
      );
    } else {
      sections.push(
        `Respond with actions: REPLY and put only the next conversational message in text. Do not call BENCHMARK_ACTION.`,
      );
    }
  } else if (isExperienceBenchmark) {
    sections.push(
      `If the phase is learning, call BENCHMARK_ACTION with command RECORD_EXPERIENCE and acknowledge it in text.`,
    );
    sections.push(
      `If the phase is retrieval, use REPLY and include any expected learning keywords from the context when relevant.`,
    );
  } else {
    sections.push(
      `Analyze the above context and take the appropriate action using BENCHMARK_ACTION.`,
    );
    sections.push(
      `Your response MUST include actions: BENCHMARK_ACTION with the correct params.`,
    );
  }

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

const LIFEOPS_BENCHMARK_TOOL_ACTION_NAMES = [
  "CALENDAR",
  "CALENDAR_CREATE_EVENT",
  "CALENDAR_UPDATE_EVENT",
  "CALENDAR_DELETE_EVENT",
  "CALENDAR_SEARCH_EVENTS",
  "CALENDAR_CHECK_AVAILABILITY",
  "CALENDAR_PROPOSE_TIMES",
  "CALENDAR_NEXT_EVENT",
  "CALENDAR_UPDATE_PREFERENCES",
] as const;

function extractActionParameters(options: unknown): Record<string, unknown> {
  let params: Record<string, unknown> = {};
  if (options && typeof options === "object") {
    const opts = options as Record<string, unknown>;
    if (opts.parameters && typeof opts.parameters === "object") {
      const p = opts.parameters as Record<string, unknown>;
      if ("fields" in p && typeof p.fields === "object") {
        const fields = p.fields as Record<
          string,
          { stringValue?: string; numberValue?: number }
        >;
        for (const [k, v] of Object.entries(fields)) {
          params[k] = v?.stringValue ?? v?.numberValue ?? v;
        }
      } else {
        params = p;
      }
    }
  }
  return params;
}

function parseCapturedArguments(
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      logger.warn(
        `[BENCHMARK_ACTION] Failed to parse arguments as JSON: ${value}`,
      );
      return { _raw: value };
    }
  }
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function captureBenchmarkAction(
  params: Record<string, unknown>,
): CapturedAction {
  return {
    params,
    command: typeof params.command === "string" ? params.command : undefined,
    toolName:
      typeof params.tool_name === "string" ? params.tool_name : undefined,
    arguments: parseCapturedArguments(params.arguments),
    operation:
      typeof params.operation === "string" ? params.operation : undefined,
    elementId:
      typeof params.element_id === "string" ? params.element_id : undefined,
    value: typeof params.value === "string" ? params.value : undefined,
  };
}

function captureLifeOpsBenchmarkToolAction(
  name: string,
  params: Record<string, unknown>,
): CapturedAction {
  return {
    params,
    toolName: name,
    arguments: params,
  };
}

export function createBenchmarkPlugin(): Plugin {
  return {
    name: "eliza-benchmark",
    description:
      "Benchmark adapter plugin — injects task context and captures actions",
    providers: [
      {
        name: "ELIZA_BENCHMARK",
        description:
          "Provides benchmark task context including goals, observations, tools, and elements",
        dynamic: true,
        position: -10,

        get: async (_runtime, _message, _state) => {
          const ctx = getBenchmarkContext();
          if (!ctx) {
            return { text: "", values: {}, data: {} };
          }

          return {
            text: formatContextAsText(ctx),
            values: {
              hasBenchmark: true,
              benchmark: ctx.benchmark,
              taskId: ctx.taskId,
            },
            data: { benchmarkContext: ctx },
          };
        },
      },
    ],

    actions: [
      {
        name: "BENCHMARK_ACTION",
        contextGate: {},
        roleGate: { minRole: "NONE" },
        similes: [
          "EXECUTE",
          "DO",
          "ACT",
          "PERFORM",
          "RUN",
          "COMMAND",
          "SEARCH",
          "CLICK",
          "ADD_TO_CART",
          "CHECKOUT",
          "ASK",
          "GUESS",
          "ANSWER",
          "QUERY",
          "GET_ENTITY",
          "FIND_RELATIONS",
          "LS",
          "CD",
          "MKDIR",
          "SQL",
          "CALL_TOOL",
          "USE_TOOL",
          "WEB_ACTION",
          "TYPE",
          "SELECT",
          "CREATE_APP_CHARGE",
          "CREATE_PAYMENT_REQUEST",
          "CHECK_PAYMENT",
          "CHARGE_USER",
        ],
        description:
          "Execute a benchmark action. Put your command/tool/operation in the params. " +
          "Supported params: command (agentbench), tool_name+arguments (tau-bench), " +
          "operation+element_id+value (mind2web).",

        validate: async () => true,

        handler: async (
          _runtime: unknown,
          _message: unknown,
          _state: unknown,
          options: unknown,
        ) => {
          const params = extractActionParameters(options);

          logger.debug("[BENCHMARK_ACTION] params:", JSON.stringify(params));

          const capturedAction = recordCapturedAction(
            captureBenchmarkAction(params),
          );

          return {
            text: `Benchmark action captured: ${JSON.stringify(capturedAction)}`,
            success: true,
            values: { captured: true },
            data: { action: capturedAction },
          };
        },

        parameters: [
          {
            name: "command",
            description: "AgentBench environment command (e.g. search[laptop])",
            required: false,
            schema: { type: "string" as const },
          },
          {
            name: "tool_name",
            description: "Tau-bench tool name to execute",
            required: false,
            schema: { type: "string" as const },
          },
          {
            name: "arguments",
            description: "JSON arguments for tool call",
            required: false,
            schema: { type: "string" as const },
          },
          {
            name: "operation",
            description: "Mind2Web operation: CLICK, TYPE, or SELECT",
            required: false,
            schema: { type: "string" as const },
          },
          {
            name: "element_id",
            description: "Mind2Web backend_node_id of the target element",
            required: false,
            schema: { type: "string" as const },
          },
          {
            name: "value",
            description: "Mind2Web text to type or option to select",
            required: false,
            schema: { type: "string" as const },
          },
          {
            name: "amount_usd",
            description: "WooBench payment amount in USD.",
            required: false,
            schema: { type: "number" as const },
          },
          {
            name: "provider",
            description: "WooBench payment provider, usually oxapay or stripe.",
            required: false,
            schema: { type: "string" as const },
          },
          {
            name: "description",
            description: "WooBench payment description.",
            required: false,
            schema: { type: "string" as const },
          },
          {
            name: "app_id",
            description: "WooBench mock app id.",
            required: false,
            schema: { type: "string" as const },
          },
        ],
      },
      ...LIFEOPS_BENCHMARK_TOOL_ACTION_NAMES.map((name) => ({
        name,
        contextGate: {},
        roleGate: { minRole: "NONE" as const },
        similes: [],
        description:
          "LifeOpsBench compatibility action. Captures a planner-emitted LifeOps tool call for the benchmark fake backend.",
        validate: async () => true,
        handler: async (_runtime, _message, _state, options) => {
          const params = extractActionParameters(options);
          logger.debug(`[${name}] params:`, JSON.stringify(params));
          const capturedAction = recordCapturedAction(
            captureLifeOpsBenchmarkToolAction(name, params),
          );
          return {
            text: `Benchmark LifeOps action captured: ${name}`,
            success: true,
            values: { captured: true },
            data: { action: capturedAction },
          };
        },
        parameters: [],
      })),
    ],
  };
}

export { BENCHMARK_MESSAGE_TEMPLATE };
