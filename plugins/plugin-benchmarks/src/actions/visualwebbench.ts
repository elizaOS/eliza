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

interface VisualWebBenchParams {
  action?: unknown;
  answer_text?: unknown;
  choice_index?: unknown;
  bbox?: unknown;
}

function readParam(
  options: HandlerOptions | Record<string, JsonValue | undefined> | undefined,
  key: keyof VisualWebBenchParams
): unknown {
  if (!options || typeof options !== "object") return undefined;
  const handler = options as HandlerOptions;
  const params = handler.parameters as VisualWebBenchParams | undefined;
  if (params && key in params && params[key] !== undefined) {
    return params[key];
  }
  return (options as Record<string, unknown>)[key];
}

const VISUALWEBBENCH_SUBACTIONS = [
  "web_caption",
  "webqa",
  "heading_ocr",
  "element_ocr",
  "element_ground",
  "action_prediction",
  "action_ground",
] as const;

export const visualWebBenchTaskAction: Action = {
  name: "VISUALWEBBENCH_TASK",
  similes: [
    "VISUALWEBBENCH",
    "WEB_CAPTION",
    "WEBQA",
    "ELEMENT_GROUND",
    "ACTION_PREDICTION",
    "ACTION_GROUND",
  ],
  description:
    "VisualWebBench task router. action selects the sub-task (web_caption, webqa, heading_ocr, element_ocr, element_ground, action_prediction, action_ground).",
  descriptionCompressed:
    "VisualWebBench web_caption|webqa|heading_ocr|element_ocr|ground|action_predict",

  parameters: [
    {
      name: "action",
      description: "VisualWebBench sub-task to execute.",
      required: true,
      schema: { type: "string", enum: [...VISUALWEBBENCH_SUBACTIONS] },
    },
    {
      name: "answer_text",
      description: "Free-text answer for caption / QA / OCR tasks.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "choice_index",
      description: "Selected choice index (0-based) for multiple-choice tasks.",
      required: false,
      schema: { type: "integer" },
    },
    {
      name: "bbox",
      description: "Bounding box [x1, y1, x2, y2] in pixels for grounding tasks.",
      required: false,
      schema: {
        type: "array",
        description: "Exactly four numbers: [x1, y1, x2, y2].",
        items: { type: "number" },
      },
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
    for (const key of ["answer_text", "choice_index", "bbox"] as const) {
      const value = readParam(options, key);
      if (value !== undefined) data[key] = value as JsonValue;
    }
    return {
      success: true,
      text: "Bench-side handler — VisualWebBench evaluator scores the action.",
      data,
    };
  },

  examples: [
    [
      {
        name: "{{agentName}}",
        content: {
          text: "Predicting the next action: choice 2.",
          actions: ["VISUALWEBBENCH_TASK"],
        },
      },
    ],
    [
      {
        name: "{{agentName}}",
        content: {
          text: "Grounding the Submit button at [320, 480, 410, 510].",
          actions: ["VISUALWEBBENCH_TASK"],
        },
      },
    ],
  ],
};
