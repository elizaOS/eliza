/**
 * Unit tests for cloud model schema: validates JSONSchema generation for AI model settings.
 */
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
    expect(schema.type).toBe("object");
    expect(schema.properties.nano).toBeDefined();
    expect(hints.nano.options?.length).toBe(1);
    expect(hints.responseHandler).toBeDefined();
    expect(hints.actionPlanner).toBeDefined();
  });
});
