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

interface OsworldParams {
  action?: unknown;
  x?: unknown;
  y?: unknown;
  text?: unknown;
  key?: unknown;
  direction?: unknown;
  amount?: unknown;
}

function readParam(
  options: HandlerOptions | Record<string, JsonValue | undefined> | undefined,
  key: keyof OsworldParams
): unknown {
  if (!options || typeof options !== "object") return undefined;
  const handler = options as HandlerOptions;
  const params = handler.parameters as OsworldParams | undefined;
  if (params && key in params && params[key] !== undefined) {
    return params[key];
  }
  return (options as Record<string, unknown>)[key];
}

const OSWORLD_SUBACTIONS = [
  "click",
  "double_click",
  "right_click",
  "type",
  "key",
  "scroll",
  "drag",
  "screenshot",
  "wait",
  "done",
  "fail",
] as const;

export const osworldAction: Action = {
  name: "OSWORLD",
  similes: [
    "OSWORLD_CLICK",
    "OSWORLD_TYPE",
    "OSWORLD_PRESS",
    "OSWORLD_SCREENSHOT",
    "COMPUTER_USE",
    "COMPUTER_USE_CLICK",
    "COMPUTER_USE_TYPE",
    "PYAUTOGUI",
  ],
  description:
    "OSWorld desktop-control router. Bridges OSWorld pyautogui semantics (click, type, key, scroll, drag, screenshot, wait, done, fail) into a structured eliza action.",
  descriptionCompressed:
    "OSWorld ops: click, double_click, right_click, type, key, scroll, drag, screenshot, wait, done, fail.",

  parameters: [
    {
      name: "action",
      description: "OSWorld desktop operation to execute.",
      required: true,
      schema: { type: "string", enum: [...OSWORLD_SUBACTIONS] },
    },
    {
      name: "x",
      description: "Pointer x coordinate in screen pixels.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "y",
      description: "Pointer y coordinate in screen pixels.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "text",
      description: "For type — the literal text to type into the focused element.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "key",
      description: "For key — the key or chord to press (e.g. 'enter', 'ctrl+s').",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "direction",
      description: "For scroll/drag — direction of motion.",
      required: false,
      schema: { type: "string", enum: ["up", "down", "left", "right"] },
    },
    {
      name: "amount",
      description: "For scroll/drag — magnitude of motion in steps or pixels.",
      required: false,
      schema: { type: "number" },
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
    for (const key of ["x", "y", "text", "key", "direction", "amount"] as const) {
      const value = readParam(options, key);
      if (value !== undefined) data[key] = value as JsonValue;
    }
    return {
      success: true,
      text: "Bench-side handler — OSWorld environment executes the action.",
      data,
    };
  },

  examples: [
    [
      {
        name: "{{agentName}}",
        content: {
          text: "Clicking on the Save button at (412, 88).",
          actions: ["OSWORLD"],
        },
      },
    ],
    [
      {
        name: "{{agentName}}",
        content: {
          text: "Pressing ctrl+s to save the document.",
          actions: ["OSWORLD"],
        },
      },
    ],
  ],
};
