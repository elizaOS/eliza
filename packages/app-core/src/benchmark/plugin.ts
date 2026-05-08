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
  command?: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  operation?: string;
  elementId?: string;
  value?: string;
}

let _capturedAction: CapturedAction | null = null;

export function getCapturedAction(): CapturedAction | null {
  return _capturedAction;
}

export function clearCapturedAction(): void {
  _capturedAction = null;
}

// ---------------------------------------------------------------------------
// Message handler template
// ---------------------------------------------------------------------------

const BENCHMARK_MESSAGE_TEMPLATE = `task: Execute the benchmark task for {{agentName}}.

providers:
{{providers}}

critical_instructions:
You are {{agentName}}, an AI agent executing a benchmark task.

STEP 1: Find the "# Benchmark Task" section in the providers above. Read:
- The task goal / instruction
- Current state / observation
- Available actions or tools

STEP 2: Choose ONE action to take based on the benchmark type.

STEP 3: Use native tool/action calling when available.

For AgentBench tasks (command-based), call BENCHMARK_ACTION with:
{
  "command": "[YOUR ACTION - e.g., search[laptop], click[42], ask[question], ls, SELECT * FROM users]"
}

For Tool-calling tasks (tau-bench), call BENCHMARK_ACTION with:
{
  "tool_name": "[TOOL NAME]",
  "arguments": {
    "key": "value"
  }
}

For Web navigation tasks (mind2web), call BENCHMARK_ACTION with:
{
  "operation": "[CLICK|TYPE|SELECT]",
  "element_id": "[BACKEND NODE ID]",
  "value": "[TEXT FOR TYPE/SELECT, empty for CLICK]"
}

For question-answering / text tasks:
Use REPLY with text: [YOUR ANSWER HERE]

For JSON-plan tasks (hyperliquid_bench):
Use REPLY with text: {"steps":[...]}

For Vending-Bench tasks:
Use REPLY with text: {"action":"PLACE_ORDER","supplier_id":"beverage_dist","items":{"water":12}}

If native tool/action calling is unavailable for an action benchmark, return one JSON object:
{
  "thought": "[brief reason]",
  "actions": ["BENCHMARK_ACTION"],
  "text": "[brief status]",
  "params": {
    "BENCHMARK_ACTION": {
      "command": "[command]"
    }
  }
}

RULES:
- Always use BENCHMARK_ACTION (not the raw action name) for action-based benchmarks
- For pure Q&A benchmarks (context-bench, rlm-bench, gaia), use REPLY with the answer in text
- For hyperliquid_bench and vending-bench, use REPLY with the exact JSON payload in text
- For swe_bench, use REPLY with a single unified diff in text
- For experience learning turns, use BENCHMARK_ACTION with command RECORD_EXPERIENCE
- Never use REPLY for benchmarks that need tool/command execution
- For text-format fallback, output JSON only. Do not output XML tags or markdown fences.
- Be precise and decisive — choose the best action immediately
`;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

function formatContextAsText(ctx: BenchmarkContext): string {
  const sections: string[] = [];
  const benchmark = ctx.benchmark.trim().toLowerCase();
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
  const isConversationalBenchmark = new Set(["woobench", "woo-bench"]).has(
    benchmark,
  );

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
    const toolLines = ctx.tools.map((t) => {
      const name = t.name ?? "unknown";
      const desc = t.description ?? "";
      const params = t.parameters
        ? JSON.stringify(t.parameters, null, 2)
        : "{}";
      return `- **${name}**: ${desc}\n  Parameters: ${params}`;
    });
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
  ]);
  const extras = Object.entries(ctx).filter(([k]) => !knownKeys.has(k));
  if (extras.length > 0) {
    sections.push(
      `\n## Additional Context\n${extras.map(([k, v]) => `- **${k}**: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n")}`,
    );
  }

  sections.push(`\n## Instructions`);

  if (ctx.tools && ctx.tools.length > 0) {
    // Tau-bench: emphasise tool calling
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
    sections.push(
      `Respond with actions: REPLY and put only the next conversational message in text. Do not call BENCHMARK_ACTION.`,
    );
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
        roleGate: { minRole: "USER" },
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
        ],
        description:
          "Execute a benchmark action. Put your command/tool/operation in the params. " +
          "Supported params: command (agentbench), tool_name+arguments (tau-bench), " +
          "operation+element_id+value (mind2web).",

        validate: async () => getBenchmarkContext() !== null,

        handler: async (_runtime, _message, _state, options) => {
          // Extract params — TS runtime may pass as Struct, plain object, or nested
          let params: Record<string, unknown> = {};
          if (options && typeof options === "object") {
            const opts = options as Record<string, unknown>;
            if (opts.parameters && typeof opts.parameters === "object") {
              const p = opts.parameters as Record<string, unknown>;
              // If it's a protobuf Struct with .fields, extract values
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

          console.log("[BENCHMARK_ACTION] params:", JSON.stringify(params));

          _capturedAction = {
            command:
              typeof params.command === "string" ? params.command : undefined,
            toolName:
              typeof params.tool_name === "string"
                ? params.tool_name
                : undefined,
            arguments:
              typeof params.arguments === "string"
                ? (() => {
                    try {
                      return JSON.parse(params.arguments as string) as Record<
                        string,
                        unknown
                      >;
                    } catch {
                      logger.warn(
                        `[BENCHMARK_ACTION] Failed to parse arguments as JSON: ${params.arguments}`,
                      );
                      return { _raw: params.arguments as string };
                    }
                  })()
                : typeof params.arguments === "object" &&
                    params.arguments !== null
                  ? (params.arguments as Record<string, unknown>)
                  : undefined,
            operation:
              typeof params.operation === "string"
                ? params.operation
                : undefined,
            elementId:
              typeof params.element_id === "string"
                ? params.element_id
                : undefined,
            value: typeof params.value === "string" ? params.value : undefined,
          };

          return {
            text: `Benchmark action captured: ${JSON.stringify(_capturedAction)}`,
            success: true,
            values: { captured: true },
            data: { action: _capturedAction },
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
        ],
      },
    ],
  };
}

export { BENCHMARK_MESSAGE_TEMPLATE };
