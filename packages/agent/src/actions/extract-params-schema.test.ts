/**
 * Exercises complete nested schemas at the real extraction model boundary and
 * validates returned arguments with the production tool validator. The model
 * adapter deterministically selects a value from the schema it actually receives.
 */
import { type Action, ModelType } from "@elizaos/core";
import { expect, it } from "vitest";
import { createRealTestRuntime } from "../../../app-core/test/helpers/real-runtime.ts";
import { validateToolArgs } from "../../../core/src/actions/validate-tool-args.ts";
import { extractActionParamsViaLlm } from "./extract-params.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

it("carries nested constraints through extraction and retains planner values", async () => {
  const runtimeResult = await createRealTestRuntime({ withLLM: false });
  const runtime = runtimeResult.runtime;
  const action: Action = {
    name: "SCHEMA_CONTRACT",
    description: "Choose a permitted connector capability",
    similes: [],
    examples: [],
    validate: async () => true,
    handler: async () => ({ success: true }),
    parameters: [
      {
        name: "selection",
        description: "Connector permission selection",
        required: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["capabilities"],
          properties: {
            capabilities: {
              type: "array",
              items: {
                type: "string",
                enum: ["google.gmail.triage", "google.calendar.read"],
              },
            },
          },
        },
      },
    ],
  };
  let calls = 0;
  runtime.registerModel(
    ModelType.TEXT_SMALL,
    async (_runtime, params) => {
      calls++;
      if (typeof params.prompt !== "string")
        throw new Error("Extraction prompt missing");
      const line = params.prompt
        .split("\n")
        .find((value) => value.startsWith("    Schema: "));
      if (!line)
        throw new Error("Complete schema absent from extraction prompt");
      const schema: unknown = JSON.parse(line.replace("    Schema: ", ""));
      expect(schema).toEqual(action.parameters?.[0].schema);
      if (
        !isObject(schema) ||
        !isObject(schema.properties) ||
        !isObject(schema.properties.capabilities) ||
        !isObject(schema.properties.capabilities.items)
      ) {
        throw new Error(
          "Nested permission schema unavailable at model boundary",
        );
      }
      const choices = schema.properties.capabilities.items.enum;
      if (!Array.isArray(choices) || typeof choices[0] !== "string")
        throw new Error("Nested choices unavailable");
      // The validator below owns whether the selected value satisfies the declared contract.
      return JSON.stringify({ selection: { capabilities: [choices[0]] } });
    },
    "deterministic-schema-consumer",
  );
  try {
    const args = {
      runtime,
      message: {
        agentId: runtime.agentId,
        entityId: runtime.agentId,
        roomId: runtime.agentId,
        content: { text: "Choose an available permission" },
      },
      actionName: action.name,
      actionDescription: action.description,
      paramSchema: action.parameters ?? [],
      existingParams: {},
      requiredFields: ["selection"],
    };
    const result = await extractActionParamsViaLlm(args);
    expect(calls).toBe(1);
    expect(validateToolArgs(action, result)).toMatchObject({
      valid: true,
      errors: [],
    });
    expect(
      validateToolArgs(action, { selection: { capabilities: ["unsupported"] } })
        .valid,
    ).toBe(false);
    expect(
      validateToolArgs(action, {
        selection: { capabilities: ["google.gmail.triage"], extra: true },
      }).valid,
    ).toBe(false);
    const supplied = { selection: { capabilities: ["google.calendar.read"] } };
    expect(
      await extractActionParamsViaLlm({ ...args, existingParams: supplied }),
    ).toEqual(supplied);
    expect(calls).toBe(1);
  } finally {
    await runtimeResult.cleanup();
  }
});
