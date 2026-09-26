import { COMPLETION_CONTEXT_SCHEMA, type JSONSchema } from "@elizaos/core";
import { expect, it } from "vitest";
import {
  ACTION_CONTEXT_ARG,
  completionContextFieldInstructions,
  runPlannerLoop,
  withSharedCompletionContextDescriptions,
} from "../planner-loop.ts";

const schema: JSONSchema = {
  ...COMPLETION_CONTEXT_SCHEMA,
  properties: {
    ...COMPLETION_CONTEXT_SCHEMA.properties,
    sourceSetId: {
      type: "string",
      enum: ["a".repeat(64)],
      description:
        "Use this exact identity for the originals supplied with this planner request.",
    },
  },
};

it("preserves every schema constraint and exact field instruction while sharing descriptions", () => {
  const original = structuredClone(schema);
  const instruction = completionContextFieldInstructions(schema);
  const result = withSharedCompletionContextDescriptions(schema, instruction);
  expect(result).not.toBe(schema);
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const { description, ...validation } = property;
    expect(result.properties?.[name]).toEqual(validation);
    if (description) expect(instruction).toContain(`${name}: ${description}`);
  }
  const {
    properties: _before,
    description: _oldDescription,
    ...before
  } = schema;
  const { properties: _after, description, ...after } = result;
  expect(after).toEqual(before);
  expect(description).toContain(
    "Follow the shared Completion-context field instructions",
  );
  expect(schema).toEqual(original);
  expect(JSON.stringify(result).length).toBeLessThan(
    JSON.stringify(schema).length,
  );
});

it("retains full descriptions for isolated callers, a title-only rule, or a stale contract", () => {
  expect(withSharedCompletionContextDescriptions(schema)).toBe(schema);
  expect(
    withSharedCompletionContextDescriptions(
      schema,
      `Completion-context field instructions (${ACTION_CONTEXT_ARG}):`,
    ),
  ).toBe(schema);
  expect(
    withSharedCompletionContextDescriptions(
      schema,
      completionContextFieldInstructions(COMPLETION_CONTEXT_SCHEMA),
    ),
  ).toBe(schema);
});

it("sends the exact contract once in trusted system instructions with required fields on each domain tool", async () => {
  let request:
    | {
        messages: Array<{ role: string; content: unknown }>;
        tools: Array<{ name: string; parameters: JSONSchema }>;
      }
    | undefined;
  await runPlannerLoop({
    runtime: {
      useModel: async (_type, params) => {
        request = params as typeof request;
        return {
          text: "Ready.",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
    },
    context: {
      id: "description-sharing",
      events: [
        {
          id: "history:1",
          type: "segment",
          source: "prior-dialogue",
          segment: {
            id: "history:1",
            label: "prior_message:user",
            content: "Keep the original title.",
            stable: false,
          },
        },
      ],
    },
    tools: ["NOTES", "CALENDAR", "REPLY"].map((name) => ({
      name,
      description: name,
      parameters: { type: "object", properties: {} },
    })),
    evaluate: async () => ({
      success: true,
      decision: "FINISH",
      messageToUser: "Ready.",
    }),
  });
  if (!request) throw new Error("Planner did not dispatch a request");
  const system = request.messages.find(
    ({ role }) => role === "system",
  )?.content;
  expect(typeof system).toBe("string");
  const instructions = system as string;
  expect(
    instructions.split(
      `Completion-context field instructions (${ACTION_CONTEXT_ARG}):`,
    ),
  ).toHaveLength(2);
  expect(instructions).toContain(
    COMPLETION_CONTEXT_SCHEMA.properties.mode.description,
  );
  expect(instructions).toContain(
    COMPLETION_CONTEXT_SCHEMA.properties.complete.description,
  );
  for (const tool of request.tools.filter(({ name }) => name !== "REPLY")) {
    expect(tool.parameters.required).toContain(ACTION_CONTEXT_ARG);
    const selection = tool.parameters.properties?.[ACTION_CONTEXT_ARG];
    expect(selection?.description).toContain(
      "Follow the shared Completion-context field instructions",
    );
    expect(selection?.properties?.mode.enum).toEqual(
      COMPLETION_CONTEXT_SCHEMA.properties.mode.enum,
    );
    expect(selection?.properties?.mode.description).toBeUndefined();
    expect(selection?.properties?.sourceSetId.enum?.[0]).toHaveLength(64);
    expect(selection?.required).toEqual(COMPLETION_CONTEXT_SCHEMA.required);
  }
  expect(
    request.tools.find(({ name }) => name === "REPLY")?.parameters.properties?.[
      ACTION_CONTEXT_ARG
    ],
  ).toBeUndefined();
});
