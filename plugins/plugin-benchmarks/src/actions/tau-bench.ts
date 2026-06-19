import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  JsonValue,
  Memory,
  State,
} from "@elizaos/core";

interface TauBenchParams {
  tool_name?: unknown;
  arguments?: unknown;
}

function readParam(
  options: HandlerOptions | Record<string, JsonValue | undefined> | undefined,
  key: keyof TauBenchParams
): unknown {
  if (!options || typeof options !== "object") return undefined;
  const handler = options as HandlerOptions;
  const params = handler.parameters as TauBenchParams | undefined;
  if (params && key in params && params[key] !== undefined) {
    return params[key];
  }
  return (options as Record<string, unknown>)[key];
}

export const tauBenchToolAction: Action = {
  name: "TAU_BENCH_TOOL",
  similes: [
    "TAU_BENCH",
    "TAU_RETAIL",
    "TAU_AIRLINE",
    "GET_ORDER_DETAILS",
    "GET_ORDER_STATUS",
    "SEARCH_FLIGHTS",
    "BOOK_FLIGHT",
    "GET_USER_DETAILS",
    "UPDATE_ORDER_ADDRESS",
    "CANCEL_ORDER",
    "RETURN_ITEMS",
    "EXCHANGE_ITEMS",
  ],
  description:
    "tau-bench pass-through tool router. Tools are dynamic per task (retail/airline domains); set tool_name to the desired tool and arguments to its JSON payload.",
  descriptionCompressed: "tau-bench dynamic tool call {tool_name,arguments} passthrough",

  parameters: [
    {
      name: "tool_name",
      description:
        "Name of the tau-bench tool to invoke (e.g. get_order_details, search_flights, cancel_order).",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "arguments",
      description: "JSON object with the tool's argument payload.",
      required: false,
      schema: { type: "object", additionalProperties: true },
    },
  ],

  validate: async (_runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> => {
    return true;
  },

  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: HandlerOptions | Record<string, JsonValue | undefined>,
    _callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const toolName = readParam(options, "tool_name") as JsonValue;
    const args = readParam(options, "arguments") as JsonValue;
    return {
      success: true,
      text: "Bench-side handler — tau-bench environment dispatches the tool call.",
      data: {
        tool_name: toolName,
        arguments: args,
      },
    };
  },

  examples: [
    [
      {
        name: "{{agentName}}",
        content: {
          text: "Looking up the order details for the user.",
          actions: ["TAU_BENCH_TOOL"],
        },
      },
    ],
    [
      {
        name: "{{agentName}}",
        content: {
          text: "I'll search for available flights for that route.",
          actions: ["TAU_BENCH_TOOL"],
        },
      },
    ],
  ],
};
