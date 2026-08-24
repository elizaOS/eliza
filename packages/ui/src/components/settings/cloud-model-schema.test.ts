/** Pins the deterministic schema and UI hints emitted for cloud model settings. */
import { describe, expect, it } from "vitest";
import {
  buildCloudModelSchema,
  DEFAULT_ACTION_PLANNER_MODEL,
  DEFAULT_RESPONSE_HANDLER_MODEL,
} from "./cloud-model-schema.ts";

describe("cloud-model-schema", () => {
  it("exports default model override constants", () => {
    expect(DEFAULT_RESPONSE_HANDLER_MODEL).toBe("__DEFAULT_RESPONSE_HANDLER__");
    expect(DEFAULT_ACTION_PLANNER_MODEL).toBe("__DEFAULT_ACTION_PLANNER__");
  });

  it("builds valid JSONSchema and hints for model options", () => {
    const options = {
      nano: [
        {
          id: "nano-1",
          name: "Nano 1",
          provider: "OpenAI",
          description: "Fast",
        },
      ],
      small: [
        {
          id: "small-1",
          name: "Small 1",
          provider: "OpenAI",
          description: "Lightweight",
        },
      ],
      medium: [],
      large: [],
      mega: [],
    };

    const { schema, hints } = buildCloudModelSchema(options);
    expect(schema).toEqual({
      type: "object",
      properties: {
        nano: {
          type: "string",
          enum: ["nano-1"],
          description: "Fastest, cheapest text tier.",
        },
        small: {
          type: "string",
          enum: ["small-1"],
          description: "Default lightweight text tier.",
        },
        medium: {
          type: "string",
          enum: [],
          description: "Planning tier. Falls back to small.",
        },
        large: {
          type: "string",
          enum: [],
          description: "Primary high-capability text tier.",
        },
        mega: {
          type: "string",
          enum: [],
          description: "Future top tier. Falls back to large.",
        },
        responseHandler: {
          type: "string",
          enum: [DEFAULT_RESPONSE_HANDLER_MODEL, "nano-1", "small-1"],
          description:
            "Should-respond / response-handler override. Defaults to nano.",
        },
        actionPlanner: {
          type: "string",
          enum: [DEFAULT_ACTION_PLANNER_MODEL, "nano-1", "small-1"],
          description: "Planning override. Defaults to medium.",
        },
      },
      required: [],
    });
    expect(hints).toEqual({
      nano: {
        label: "Nano Model",
        width: "half",
        options: [
          {
            value: "nano-1",
            label: "Nano 1",
            description: "OpenAI - Fast",
          },
        ],
      },
      small: {
        label: "Small Model",
        width: "half",
        options: [
          {
            value: "small-1",
            label: "Small 1",
            description: "OpenAI - Lightweight",
          },
        ],
      },
      medium: { label: "Medium Model", width: "half", options: [] },
      large: { label: "Large Model", width: "half", options: [] },
      mega: { label: "Mega Model", width: "half", options: [] },
      responseHandler: {
        label: "Response Handler",
        width: "half",
        options: [
          {
            value: DEFAULT_RESPONSE_HANDLER_MODEL,
            label: "Default (Nano)",
            description: "Use the nano tier unless explicitly overridden.",
          },
          {
            value: "nano-1",
            label: "Nano 1",
            description: "OpenAI - Fast",
          },
          {
            value: "small-1",
            label: "Small 1",
            description: "OpenAI - Lightweight",
          },
        ],
      },
      actionPlanner: {
        label: "Action Planner",
        width: "half",
        options: [
          {
            value: DEFAULT_ACTION_PLANNER_MODEL,
            label: "Default (Medium)",
            description: "Use the medium tier unless explicitly overridden.",
          },
          {
            value: "nano-1",
            label: "Nano 1",
            description: "OpenAI - Fast",
          },
          {
            value: "small-1",
            label: "Small 1",
            description: "OpenAI - Lightweight",
          },
        ],
      },
    });
  });
});
