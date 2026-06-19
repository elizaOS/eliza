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

interface VendingParams {
  action?: unknown;
  slot_id?: unknown;
  product_id?: unknown;
  supplier_id?: unknown;
  price?: unknown;
  quantity?: unknown;
  notes?: unknown;
}

function readParam(
  options: HandlerOptions | Record<string, JsonValue | undefined> | undefined,
  key: keyof VendingParams
): unknown {
  if (!options || typeof options !== "object") return undefined;
  const handler = options as HandlerOptions;
  const params = handler.parameters as VendingParams | undefined;
  if (params && key in params && params[key] !== undefined) {
    return params[key];
  }
  return (options as Record<string, unknown>)[key];
}

const VENDING_SUBACTIONS = [
  "view_state",
  "view_suppliers",
  "place_order",
  "restock_slot",
  "set_price",
  "collect_cash",
  "update_notes",
  "check_deliveries",
  "advance_day",
] as const;

export const vendingMachineAction: Action = {
  name: "VENDING_MACHINE",
  similes: [
    "VENDING_MACHINE_VIEW_BUSINESS_STATE",
    "VIEW_BUSINESS_STATE",
    "VIEW_STATE",
    "VIEW_SUPPLIERS",
    "PLACE_ORDER",
    "RESTOCK_SLOT",
    "SET_PRICE",
    "COLLECT_CASH",
    "UPDATE_NOTES",
    "CHECK_DELIVERIES",
    "ADVANCE_DAY",
  ],
  description:
    "Vending-bench tool router. action selects the operation against the vending environment.",
  descriptionCompressed:
    "Vending-machine ops: view_state, place_order, restock, set_price, collect_cash, …",

  parameters: [
    {
      name: "action",
      description: "Vending-bench operation to execute.",
      required: true,
      schema: { type: "string", enum: [...VENDING_SUBACTIONS] },
    },
    {
      name: "slot_id",
      description: "Slot identifier within the vending machine grid.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "product_id",
      description: "Catalogue product identifier (SKU).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "supplier_id",
      description: "Identifier for the supplier when placing or inspecting orders.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "price",
      description: "Unit price (in machine-local currency units).",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "quantity",
      description: "Quantity to order, restock, or collect.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "notes",
      description: "Free-form note text attached to the operation.",
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
    for (const key of [
      "slot_id",
      "product_id",
      "supplier_id",
      "price",
      "quantity",
      "notes",
    ] as const) {
      const value = readParam(options, key);
      if (value !== undefined) data[key] = value as JsonValue;
    }
    return {
      success: true,
      text: "Bench-side handler — vending-bench environment executes the action.",
      data,
    };
  },

  examples: [
    [
      {
        name: "{{agentName}}",
        content: {
          text: "Let me check the vending machine inventory.",
          actions: ["VENDING_MACHINE"],
        },
      },
    ],
    [
      {
        name: "{{agentName}}",
        content: {
          text: "I'll place an order with supplier S1 for 24 units of P3.",
          actions: ["VENDING_MACHINE"],
        },
      },
    ],
  ],
};
