import {
  COMPLETION_CONTEXT_SCHEMA,
  type JSONSchema,
  type ToolDefinition,
} from "@elizaos/core";
import { expect, it } from "vitest";
import {
  isCerebrasSchemaUnbounded,
  normalizeSchemaForCerebras,
} from "../../../../plugin-openai/utils/schema-compat.ts";
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

it.each(["description", "x-policy"])(
  "preserves the %s accessor and the same provider rejection/read count with or without a duplicate carrier",
  async (key) => {
    const policy =
      "The complete current request policy must stay available. ".repeat(8);
    let getterCalls = 0;
    const getter = () => {
      getterCalls += 1;
      return policy;
    };
    const hostile: JSONSchema = { type: "string", description: policy };
    Object.defineProperty(hostile, key, {
      enumerable: true,
      configurable: true,
      get: getter,
    });
    const dispatch = async (withCarrier: boolean) => {
      getterCalls = 0;
      let normalized = false;
      await runPlannerLoop({
        runtime: {
          useModel: async (_type, params) => {
            const tools = params.tools as ToolDefinition[];
            const second = tools.find(
              (tool) => tool.name === "SECOND",
            )?.parameters;
            expect(
              Object.getOwnPropertyDescriptor(
                second?.properties?.plan ?? {},
                key,
              )?.get,
            ).toBe(getter);
            const beforeNormalization = getterCalls;
            try {
              normalizeSchemaForCerebras(second, true);
              throw new Error("Accessor schema reached provider dispatch");
            } catch (error) {
              expect(isCerebrasSchemaUnbounded(error)).toBe(true);
            }
            expect(getterCalls).toBe(beforeNormalization);
            normalized = true;
            return {
              text: "Ready.",
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            };
          },
        },
        context: { id: "accessor-description", events: [] },
        tools: [
          ...(withCarrier
            ? [
                {
                  name: "FIRST",
                  parameters: {
                    type: "object" as const,
                    properties: {
                      plan: { type: "string" as const, description: policy },
                    },
                  },
                },
              ]
            : []),
          {
            name: "SECOND",
            parameters: { type: "object", properties: { plan: hostile } },
          },
        ],
        evaluate: async () => ({
          success: true,
          decision: "FINISH",
          messageToUser: "Ready.",
        }),
      });
      expect(normalized).toBe(true);
      expect(Object.getOwnPropertyDescriptor(hostile, key)?.get).toBe(getter);
      return getterCalls;
    };
    // The existing budget JSON serialization can read a getter. Factoring
    // must add no read and must not erase the provider's rejecting descriptor.
    const withoutCarrier = await dispatch(false);
    expect(await dispatch(true)).toBe(withoutCarrier);
  },
);

it.each(["non-enumerable", "inherited"])(
  "does not reference a %s description that is absent from the serialized carrier",
  async (kind) => {
    const policy =
      "The complete current request policy must stay available. ".repeat(8);
    const invisible: JSONSchema =
      kind === "inherited" ? Object.create({ description: policy }) : {};
    invisible.type = "string";
    if (kind === "non-enumerable")
      Object.defineProperty(invisible, "description", { value: policy });
    let sent: ToolDefinition[] | undefined;
    await runPlannerLoop({
      runtime: {
        useModel: async (_type, params) => {
          sent = params.tools as ToolDefinition[];
          return {
            text: "Ready.",
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
        },
      },
      context: { id: "invisible-carrier", events: [] },
      tools: [
        {
          name: "FIRST",
          parameters: { type: "object", properties: { plan: invisible } },
        },
        {
          name: "SECOND",
          parameters: {
            type: "object",
            properties: { plan: { type: "string", description: policy } },
          },
        },
      ],
      evaluate: async () => ({
        success: true,
        decision: "FINISH",
        messageToUser: "Ready.",
      }),
    });
    expect(sent?.[1].parameters?.properties?.plan.description).toBe(policy);
    expect(
      JSON.stringify(sent?.[0].parameters?.properties?.plan),
    ).not.toContain(policy);
  },
);

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

it("shares only identical top-level parameter descriptions on the actual offered request without changing validation or originals", async () => {
  const policy =
    "Keep every requested destination, timing constraint and permission bound to its current source. ".repeat(
      8,
    );
  const nestedPolicy =
    "This nested instruction stays complete on each schema. ".repeat(8);
  const parameter: JSONSchema = {
    type: "object",
    description: policy,
    properties: {
      mode: {
        type: "string",
        enum: ["create", "respond"],
        description: nestedPolicy,
      },
    },
    required: ["mode"],
    additionalProperties: false,
  };
  Object.assign(parameter, { vendorConstraint: { retained: true } });
  const tools: ToolDefinition[] = [
    "OWNER_REMINDERS",
    "OWNER_REMINDERS_CREATE",
  ].map((name) => ({
    name,
    description: name,
    parameters: {
      type: "object",
      properties: {
        createPlan: structuredClone(parameter),
        other: { type: "string", description: `${policy} ${name}` },
        short: { type: "string", description: "Choose one." },
      },
      required: ["createPlan"],
      additionalProperties: false,
    },
  }));
  const original = structuredClone(tools);
  const dispatch = async (offered: ToolDefinition[]) => {
    let sent: ToolDefinition[] | undefined;
    await runPlannerLoop({
      runtime: {
        useModel: async (_type, params) => {
          sent = params.tools as ToolDefinition[];
          return {
            text: "Ready.",
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
        },
      },
      context: { id: "parameter-description-sharing", events: [] },
      tools: offered,
      evaluate: async () => ({
        success: true,
        decision: "FINISH",
        messageToUser: "Ready.",
      }),
    });
    if (!sent) throw new Error("Planner did not dispatch a request");
    return sent;
  };
  const sent = await dispatch(tools);
  expect(sent.map((tool) => tool.name)).toEqual(tools.map((tool) => tool.name));
  const first = sent[0].parameters?.properties?.createPlan;
  const second = sent[1].parameters?.properties?.createPlan;
  expect(first?.description).toBe(policy);
  expect(second?.description).toBe(
    'Use the identical full description of parameter "createPlan" on tool OWNER_REMINDERS.',
  );
  const { description: _firstDescription, ...firstValidation } = first ?? {};
  const { description: _secondDescription, ...secondValidation } = second ?? {};
  expect(secondValidation).toEqual(firstValidation);
  expect(secondValidation).toEqual(
    Object.fromEntries(
      Object.entries(parameter).filter(([key]) => key !== "description"),
    ),
  );
  for (const [index, tool] of sent.entries()) {
    expect(tool.parameters?.properties?.other).toEqual(
      original[index].parameters?.properties?.other,
    );
    expect(tool.parameters?.properties?.short).toEqual(
      original[index].parameters?.properties?.short,
    );
    expect(tool.parameters?.required).toContain("createPlan");
    expect(tool.parameters?.required).toContain("eliza_turn_scope");
    expect(tool.parameters?.additionalProperties).toBe(false);
  }
  expect(tools).toEqual(original);

  // The next request has no former carrier: it must keep the full policy.
  const isolated = await dispatch([tools[1]]);
  expect(isolated[0].parameters?.properties?.createPlan?.description).toBe(
    policy,
  );
  // Reordering selects a carrier that actually exists in this request.
  const reordered = await dispatch([tools[1], tools[0]]);
  expect(reordered[0].parameters?.properties?.createPlan?.description).toBe(
    policy,
  );
  expect(
    reordered[1].parameters?.properties?.createPlan?.description,
  ).toContain("on tool OWNER_REMINDERS_CREATE.");
  const changed = structuredClone(tools);
  const changedProperties = changed[0].parameters?.properties;
  if (!changedProperties) throw new Error("Missing fixture parameters");
  changedProperties.createPlan.description = `${policy} Different policy.`;
  const changedRequest = await dispatch(changed);
  expect(
    changedRequest[0].parameters?.properties?.createPlan?.description,
  ).toBe(`${policy} Different policy.`);
  expect(
    changedRequest[1].parameters?.properties?.createPlan?.description,
  ).toBe(policy);
  const renamed = structuredClone(tools);
  const renamedParameters = renamed[0].parameters;
  const renamedProperties = renamedParameters?.properties;
  if (!renamedParameters || !renamedProperties)
    throw new Error("Missing fixture parameters");
  renamedProperties.draft = renamedProperties.createPlan;
  delete renamedProperties.createPlan;
  renamedParameters.required = ["draft"];
  const renamedRequest = await dispatch(renamed);
  expect(
    renamedRequest[1].parameters?.properties?.createPlan?.description,
  ).toBe(
    'Use the identical full description of parameter "draft" on tool OWNER_REMINDERS.',
  );
  const sameTool = structuredClone(tools[0]);
  const sameToolProperties = sameTool.parameters?.properties;
  if (!sameToolProperties) throw new Error("Missing fixture parameters");
  sameToolProperties.duplicatePlan = structuredClone(parameter);
  const sameToolRequest = await dispatch([sameTool]);
  expect(
    sameToolRequest[0].parameters?.properties?.duplicatePlan?.description,
  ).toBe(policy);
  expect(tools).toEqual(original);
});
