import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  JsonValue,
  Memory,
  ProviderDataRecord,
  State,
} from "@elizaos/core";

interface WebshopParams {
  action?: unknown;
  query?: unknown;
  product_id?: unknown;
  option_name?: unknown;
  option_value?: unknown;
}

function readParam(
  options: HandlerOptions | Record<string, JsonValue | undefined> | undefined,
  key: keyof WebshopParams
): unknown {
  if (!options || typeof options !== "object") return undefined;
  const handler = options as HandlerOptions;
  const params = handler.parameters as WebshopParams | undefined;
  if (params && key in params && params[key] !== undefined) {
    return params[key];
  }
  return (options as Record<string, unknown>)[key];
}

const WEBSHOP_SUBACTIONS = ["search", "click", "select_option", "back", "buy"] as const;

export const webshopAction: Action = {
  name: "WEBSHOP",
  similes: [
    "WEBSHOP_SEARCH",
    "WEBSHOP_CLICK",
    "WEBSHOP_SELECT_OPTION",
    "WEBSHOP_BACK",
    "WEBSHOP_BUY",
    "SHOP",
    "SHOPPING",
    "NAVIGATE_SHOP",
  ],
  description:
    "WebShop benchmark router. Mirrors the WebShop environment shape: search[query], click[ID], select_option[name,value], back, and buy.",
  descriptionCompressed: "WebShop ops: search, click, select_option, back, buy.",

  parameters: [
    {
      name: "action",
      description: "WebShop operation to execute.",
      required: true,
      schema: { type: "string", enum: [...WEBSHOP_SUBACTIONS] },
    },
    {
      name: "query",
      description: "For search — the free-text query string used as search[query].",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "product_id",
      description: "For click — the product or element identifier used as click[ID].",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "option_name",
      description: "For select_option — the option name used as select_option[name,value].",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "option_value",
      description: "For select_option — the option value used as select_option[name,value].",
      required: false,
      schema: { type: "string" },
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
    const data: ProviderDataRecord = { action: readParam(options, "action") as JsonValue };
    for (const key of ["query", "product_id", "option_name", "option_value"] as const) {
      const value = readParam(options, key);
      if (value !== undefined) data[key] = value as JsonValue;
    }
    return {
      success: true,
      text: "Bench-side handler — WebShop environment executes the action.",
      data,
    };
  },

  examples: [
    [
      {
        name: "{{agentName}}",
        content: {
          text: "I'll search for 'long sleeve cotton dress under $50'.",
          actions: ["WEBSHOP"],
        },
      },
    ],
    [
      {
        name: "{{agentName}}",
        content: {
          text: "Selecting size medium and clicking Buy Now.",
          actions: ["WEBSHOP"],
        },
      },
    ],
  ],
};
