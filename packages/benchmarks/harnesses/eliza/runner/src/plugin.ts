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
import { AsyncLocalStorage } from "node:async_hooks";
import { type Action, ElizaError, logger, type Plugin } from "@elizaos/core";
import {
  LIFEOPS_BENCHMARK_TOOL_ACTION_NAMES,
  LIFEOPS_BENCHMARK_TOOL_PARAMETERS,
  lifeOpsBenchmarkToolDescription,
} from "@elizaos/lifeops-bench";
import {
  LOCA_BENCHMARK_TOOL_ACTION_NAMES,
  locaBenchmarkToolParametersFor,
} from "@elizaos/plugin-benchmarks";

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

interface BenchmarkTurn {
  context: BenchmarkContext;
  actions: CapturedAction[];
}

const benchmarkTurn = new AsyncLocalStorage<BenchmarkTurn>();

export function getBenchmarkContext(): BenchmarkContext | null {
  return benchmarkTurn.getStore()?.context ?? null;
}

export async function runWithBenchmarkContext<T>(
  context: BenchmarkContext,
  fn: () => Promise<T> | T,
): Promise<{ result: T; capturedActions: CapturedAction[] }> {
  const turn: BenchmarkTurn = { context, actions: [] };
  return benchmarkTurn.run(turn, async () => ({
    result: await fn(),
    capturedActions: [...turn.actions],
  }));
}

function currentBenchmarkName(): string {
  return (getBenchmarkContext()?.benchmark ?? "").trim().toLowerCase();
}

function isBenchmarkActionDisabledForCurrentContext(): boolean {
  // The standard public suite (MMLU / GSM8K / HumanEval / MT-Bench) measures
  // plain text answers through the normal agent pipeline and declares an
  // empty tool surface (`tools: []`). Exposing BENCHMARK_ACTION there is an
  // attractive nuisance: its ANSWER/GUESS similes lure the planner into
  // detouring a one-shot exam answer through the tool + completion-evaluator
  // machinery, which multiplies LLM calls and can end the turn in a
  // trajectory-limit apology instead of the answer.
  return currentBenchmarkName() === "standard";
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

function recordCapturedAction(action: CapturedAction): CapturedAction {
  const turn = benchmarkTurn.getStore();
  if (!turn) {
    throw new ElizaError("Benchmark action requires an active turn", {
      code: "BENCHMARK_TURN_REQUIRED",
    });
  }
  turn.actions.push(action);
  return action;
}

const VENDING_BENCHMARK_ACTION_NAMES = [
  "VIEW_BUSINESS_STATE",
  "VIEW_SUPPLIERS",
  "SET_PRICE",
  "PLACE_ORDER",
  "RESTOCK_SLOT",
  "COLLECT_CASH",
  "UPDATE_NOTES",
  "CHECK_DELIVERIES",
  "ADVANCE_DAY",
] as const;

function isVendingBenchmarkContext(): boolean {
  return new Set(["vending-bench", "vending_bench"]).has(
    currentBenchmarkName(),
  );
}

function isLocaBenchmarkContext(): boolean {
  return new Set(["loca-bench", "loca_bench"]).has(currentBenchmarkName());
}

// ---------------------------------------------------------------------------
// Message handler template
// ---------------------------------------------------------------------------

const BENCHMARK_MESSAGE_TEMPLATE = `task: Execute the benchmark task for {{agentName}}. Read the "# Benchmark Task" section in providers below for goal, observation, and available actions; choose one decisive action.

providers:
{{providers}}

action-based benchmarks: call BENCHMARK_ACTION with one of:
- AgentBench: { "command": "search[laptop] | click[42] | ls | SELECT ..." }
- WebShop: { "command": "search[...] | click[...] | buy" }
- Tau-bench: { "tool_name": "...", "arguments": { ... } }
- LifeOpsBench: { "tool_name": "CALENDAR", "arguments": { "subaction": "update_event", ... } }
- LOCA-bench: { "tool_name": "filesystem_list_directory | filesystem_read_file | filesystem_write_file | ...", "arguments": { ... } }
- Mind2Web: { "operation": "CLICK|TYPE|SELECT", "element_id": "...", "value": "..." }

reply-based benchmarks: use REPLY with text payload:
- Q&A (context-bench): the answer
- vending-bench: {"action":"PLACE_ORDER","supplier_id":"beverage_dist","items":{"water":12}}
- swe_bench: a single unified diff

experience-learning turns: BENCHMARK_ACTION with command RECORD_EXPERIENCE.

text-format fallback for action benchmarks (no native tool calling): return one JSON object:
{
  "thought": "[brief reason]",
  "actions": ["BENCHMARK_ACTION"],
  "text": "[brief status]",
  "params": { "BENCHMARK_ACTION": { "command": "[command]" } }
}

text-format fallback for reply-based benchmarks: return one JSON object:
{
  "thought": "[brief reason]",
  "actions": ["REPLY"],
  "text": "[the required answer or JSON payload]",
  "params": {}
}

rules:
- always BENCHMARK_ACTION (never raw action name) for action benchmarks
- never REPLY when execution is required
- always REPLY (never BENCHMARK_ACTION) for reply-based benchmarks such as vending-bench
`;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function contextJson(value: unknown): string {
  return typeof value === "string"
    ? value
    : (JSON.stringify(value, null, 2) ?? "null");
}

function formatToolLine(t: Record<string, unknown>): string {
  const fn = isPlainRecord(t.function) ? t.function : undefined;
  const name = t.name ?? fn?.name ?? "unknown";
  const desc = t.description ?? fn?.description ?? "";
  const params = t.parameters ?? fn?.parameters ?? {};
  return `- **${String(name)}**: ${String(desc)}\n  Parameters: ${contextJson(params)}`;
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
  ]).has(benchmark);
  const isJsonActionBenchmark = new Set(["vending-bench", "vending_bench"]).has(
    benchmark,
  );
  const isAdhdBenchmark = benchmark === "adhdbench";
  const isSweBench = benchmark === "swe_bench" || benchmark === "swe-bench";
  const isExperienceBenchmark = benchmark === "experience";
  const isGauntletBenchmark = benchmark === "gauntlet";
  const isLocaBenchmark =
    benchmark === "loca_bench" || benchmark === "loca-bench";
  const isWebShopBenchmark =
    benchmark === "webshop" || benchmark === "web-shop";
  const isTauBenchmark = benchmark === "tau_bench" || benchmark === "tau-bench";
  const isConversationalBenchmark = new Set([
    "orchestrator_lifecycle",
    "orchestrator-lifecycle",
    "personality_bench",
    "personality-bench",
  ]).has(benchmark);
  const isOrchestratorLifecycle =
    benchmark === "orchestrator_lifecycle" ||
    benchmark === "orchestrator-lifecycle";
  const isPersonalityBenchmark =
    benchmark === "personality_bench" || benchmark === "personality-bench";

  if (isOrchestratorLifecycle) {
    const sharedHint = ctx.system_hint;
    return typeof sharedHint === "string" ? sharedHint.trim() : "";
  }

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
    const lifeopsContext =
      ctx.lifeops === undefined
        ? null
        : `\n## LifeOps State\n${contextJson(ctx.lifeops)}`;
    if (lifeopsContext) sections.push(lifeopsContext);
  }

  // Tau-bench: tools
  if (isQuestionAnswerBenchmark) {
    sections.push(
      `Answer the benchmark question directly. Use REPLY, not BENCHMARK_ACTION.`,
    );
    sections.push(
      `Put only the final answer in the response text. Do not include commentary unless the task explicitly asks for it.`,
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
    sections.push(`\n## Page HTML\n\`\`\`html\n${ctx.html}\n\`\`\``);
  }

  if (ctx.elements && ctx.elements.length > 0) {
    sections.push(`\n## Available Elements\n${contextJson(ctx.elements)}`);
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
    "task_id",
    "goal",
    "observation",
    "actionSpace",
    "tools",
    "messages",
    "system_prompt",
    "session_id",
    "temperature",
    "top_p",
    "max_tokens",
    "max_completion_tokens",
    "reasoning_effort",
    "tool_choice",
    "html",
    "elements",
    "passages",
    "question",
    "payment_actions",
    "lifeops",
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
      `You have access to the benchmark's fake LifeOps calendar and inbox through the available LifeOps tools. Do not say you lack calendar, email, inbox, or app access when a matching LifeOps tool is available.`,
    );
    sections.push(
      `For calendar changes, prefer updating the existing event id from Calendar Events or a prior search result. Do not create a duplicate and delete another event unless the user explicitly asked for that.`,
    );
    sections.push(
      `For availability questions, call CALENDAR_CHECK_AVAILABILITY or CALENDAR with subaction=check_availability and top-level startAt/endAt.`,
    );
    sections.push(
      `If the requested mutation has not succeeded yet, call BENCHMARK_ACTION with params.BENCHMARK_ACTION.tool_name set to the LifeOps tool name and params.BENCHMARK_ACTION.arguments set to the tool arguments.`,
    );
    sections.push(
      `For inbox, email, chat, or thread requests, use the LifeOps MESSAGE tool, not MEMORY. MEMORY is not a LifeOpsBench executor tool.`,
    );
    sections.push(
      `For email thread archive requests, call MESSAGE with source=gmail, operation=manage, manageOperation=archive, and threadId, or call ARCHIVE_THREAD with threadId.`,
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
  } else if (isLocaBenchmark && ctx.tools && ctx.tools.length > 0) {
    sections.push(
      `This is LOCA-bench. The Python LOCA runner executes tool calls outside Eliza. Call exactly one tool through BENCHMARK_ACTION with params.BENCHMARK_ACTION.tool_name and params.BENCHMARK_ACTION.arguments. Do not claim the files are complete until the required CSV writes have been emitted as tool calls.`,
    );
    sections.push(
      `Progress replies are invalid in LOCA-bench. If the task is not complete, call exactly one tool. Only use REPLY after the requested files have been written or claim_done has been called.`,
    );
    sections.push(
      `Existing workspace files may contain examples or placeholders. Use current CSV rows for schema and formatting only; derive final answers from the available tools, local_db files, workspace files, and memory records. If Canvas-specific tools are unavailable, inspect source_data/local_db and source_data/files with filesystem tools. source_data is read-only input data; write/edit the requested output CSV files at the workspace root, for example assignment_info.csv and quiz_info.csv. Overwrite or edit every requested CSV before replying.`,
    );
    sections.push(
      `Never invent aggregate helper tools. In particular, do not call process_assignments_and_quizzes or any tool name not listed under Available Tools.`,
    );
    sections.push(
      `Example tool-call JSON: {"actions":["BENCHMARK_ACTION"],"text":"","params":{"BENCHMARK_ACTION":{"tool_name":"filesystem_list_directory","arguments":{"path":"source_data"}}}}`,
    );
  } else if (isWebShopBenchmark) {
    sections.push(
      `This is WebShop. Choose exactly one command from Available Actions and call BENCHMARK_ACTION with params.BENCHMARK_ACTION.command set to that exact command string.`,
    );
    sections.push(
      `Do not answer with progress prose. The WebShop runner executes only the captured command, for example {"actions":["BENCHMARK_ACTION"],"text":"","params":{"BENCHMARK_ACTION":{"command":"click[buy now]"}}}.`,
    );
  } else if (isTauBenchmark && ctx.tools && ctx.tools.length > 0) {
    sections.push(
      `This is TauBench. Use BENCHMARK_ACTION tool calls to gather missing customer, order, policy, and product facts.`,
    );
    sections.push(
      `Do not repeat a tool call when the same result is already available in the prompt. Move to the next missing fact or the required next customer-service step.`,
    );
    sections.push(
      `Do not describe a tool call in prose. If the task needs a tool, your response MUST include actions: BENCHMARK_ACTION with params.BENCHMARK_ACTION.tool_name set to the TauBench tool name and params.BENCHMARK_ACTION.arguments set to the JSON arguments.`,
    );
    sections.push(
      `Example tool-call JSON: {"actions":["BENCHMARK_ACTION"],"text":"","params":{"BENCHMARK_ACTION":{"tool_name":"get_order_details","arguments":{"order_id":"W2378156"}}}}`,
    );
    sections.push(
      `Use REPLY only when asking the customer for required confirmation or when the task is complete. After the customer confirms, call the final mutation tool with BENCHMARK_ACTION; do not say you are calling it.`,
    );
  } else if (ctx.tools && ctx.tools.length > 0) {
    // Tau-bench-style harnesses: emphasise tool calling
    sections.push(
      `Customer service agent. Use the available tools to help the customer.`,
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

function benchmarkProviderResult(ctx: BenchmarkContext) {
  const benchmark = ctx.benchmark.trim().toLowerCase();
  const lifecycleProfile =
    benchmark === "orchestrator_lifecycle" ||
    benchmark === "orchestrator-lifecycle";
  if (lifecycleProfile) {
    return {
      text: formatContextAsText(ctx),
      values: {},
      data: {},
    };
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
}

/** Verify the exact lifecycle provider payload carries only the shared hint. */
export function lifecycleBenchmarkProviderPayloadIsNeutral(): boolean {
  const sharedHint =
    "Manage delegated work with the available task action and report its result truthfully.";
  const payload = benchmarkProviderResult({
    benchmark: "orchestrator_lifecycle",
    taskId: "sensitive-task-id",
    model_name: "sensitive-model-name",
    scenario_id: "sensitive-scenario-id",
    expected_behaviors: ["sensitive-coaching-label"],
    system_hint: sharedHint,
  });
  return (
    payload.text === sharedHint &&
    Object.keys(payload.values).length === 0 &&
    Object.keys(payload.data).length === 0
  );
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

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
          params[k] = v.stringValue ?? v.numberValue ?? v;
        }
      } else {
        params = p;
      }
    } else {
      params = opts;
    }
  }
  return params;
}

function stripRuntimeActionContext(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const { actionContext: _actionContext, ...toolParams } = params;
  return toolParams;
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

function captureNamedBenchmarkToolAction(
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
          return benchmarkProviderResult(ctx);
        },
      },
    ],

    actions: [
      {
        name: "BENCHMARK_ACTION",
        contextGate: {},
        roleGate: { minRole: "NONE" },
        suppressPostActionContinuation: true,
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

        validate: async () => !isBenchmarkActionDisabledForCurrentContext(),

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
            continueChain:
              isVendingBenchmarkContext() || isLocaBenchmarkContext()
                ? false
                : undefined,
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
      ...VENDING_BENCHMARK_ACTION_NAMES.map(
        (name): Action => ({
          name,
          contextGate: {},
          roleGate: { minRole: "NONE" as const },
          suppressPostActionContinuation: true,
          similes: [],
          description:
            "Vending-Bench compatibility action. Captures one vending simulator action for the benchmark environment.",
          validate: async () => isVendingBenchmarkContext(),
          handler: async (_runtime, _message, _state, options) => {
            const params = extractActionParameters(options);
            logger.debug(`[${name}] params: ${JSON.stringify(params)}`);
            const capturedAction = recordCapturedAction({
              toolName: name,
              arguments: params,
              params: { tool_name: name, arguments: params },
            });
            return {
              text: `Benchmark vending action captured: ${name}`,
              success: true,
              continueChain: false,
              values: { captured: true },
              data: { action: capturedAction },
            };
          },
          parameters: [],
        }),
      ),
      ...LIFEOPS_BENCHMARK_TOOL_ACTION_NAMES.map(
        (name): Action => ({
          name,
          contextGate: {},
          roleGate: { minRole: "NONE" as const },
          suppressPostActionContinuation: true,
          similes: [],
          description: lifeOpsBenchmarkToolDescription(name),
          routingHint:
            name.startsWith("MESSAGE") || name.startsWith("ARCHIVE_")
              ? "PERSONAL_ASSISTANT: inbox/email/Gmail/chat/thread/archive/read/draft/send -> MESSAGE or ARCHIVE_THREAD; do not use MEMORY."
              : "PERSONAL_ASSISTANT: calendar/event/availability/schedule -> CALENDAR.",
          allowAdditionalParameters: true,
          validate: async () => true,
          handler: async (_runtime, _message, _state, options) => {
            const params = stripRuntimeActionContext(
              extractActionParameters(options),
            );
            logger.debug(`[${name}] params:`, JSON.stringify(params));
            const capturedAction = recordCapturedAction(
              captureNamedBenchmarkToolAction(name, params),
            );
            return {
              text: `Benchmark LifeOps action captured: ${name}`,
              success: true,
              continueChain: false,
              values: { captured: true },
              data: { action: capturedAction },
            };
          },
          parameters: LIFEOPS_BENCHMARK_TOOL_PARAMETERS,
        }),
      ),
      ...LOCA_BENCHMARK_TOOL_ACTION_NAMES.map(
        (name): Action => ({
          name,
          contextGate: {},
          roleGate: { minRole: "NONE" as const },
          suppressPostActionContinuation: true,
          similes: [],
          description:
            "LOCA-bench compatibility action. Captures a planner-emitted MCP tool call for the Python LOCA runner.",
          allowAdditionalParameters: true,
          validate: async () => isLocaBenchmarkContext(),
          handler: async (_runtime, _message, _state, options) => {
            const params = stripRuntimeActionContext(
              extractActionParameters(options),
            );
            logger.debug(`[${name}] params: ${JSON.stringify(params)}`);
            const capturedAction = recordCapturedAction(
              captureNamedBenchmarkToolAction(name, params),
            );
            return {
              text: `Benchmark LOCA action captured: ${name}`,
              success: true,
              continueChain: false,
              values: { captured: true },
              data: { action: capturedAction },
            };
          },
          parameters: locaBenchmarkToolParametersFor(name),
        }),
      ),
    ],
  };
}

export { BENCHMARK_MESSAGE_TEMPLATE };
