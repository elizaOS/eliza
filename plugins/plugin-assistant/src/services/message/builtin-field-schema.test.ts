/** Exercises native response schemas and transport parity through the real Stage-1 pipeline with deterministic model responses. */

import type {
  IAgentRuntime,
  JSONSchema,
  Memory,
  ResponseHandlerFieldEvaluator,
  State,
} from "@elizaos/core";
import {
  ChannelType,
  completionContextSources,
  ResponseHandlerFieldRegistry,
  selectCompletionContext,
  type UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as builtins from "../../runtime/builtin-field-evaluators";
import { runV5MessageRuntimeStage1 } from "../message";
import { createV5MessageContextObject } from "./context-assembly.ts";
import { withoutInactiveFields } from "./inactive-field-schema.ts";

const removed = [
  "shouldRespond",
  "contexts",
  "intents",
  "candidateActionNames",
  "relationships",
  "topics",
  "addressedTo",
  "emotion",
];
const shortened = {
  replyText: "Plain text unless channel supports markdown.",
  facts: "One plain-English fact per item.",
};

function registry(custom?: ResponseHandlerFieldEvaluator) {
  const result = new ResponseHandlerFieldRegistry();
  if (custom) result.register(custom);
  for (const field of builtins.BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS)
    result.register(field);
  return result;
}

function properties(schema: JSONSchema): Record<string, JSONSchema> {
  if (!schema.properties) throw new Error("Expected object schema");
  return schema.properties;
}

function expectedCompact(schema: JSONSchema) {
  const result = structuredClone(schema);
  for (const name of removed) delete properties(result)[name].description;
  for (const [name, description] of Object.entries(shortened))
    properties(result)[name].description = description;
  return result;
}

function response(contextRequests: string[] = []) {
  return {
    text: "",
    toolCalls: [
      {
        id: "handler",
        name: "HANDLE_RESPONSE",
        arguments: {
          shouldRespond: "RESPOND",
          contexts: ["simple"],
          intents: [],
          candidateActionNames: [],
          contextRequests,
          replyText: contextRequests.length ? "" : "Hello.",
          replyEffectStatus: "none",
          facts: [],
          relationships: [],
          topics: [],
          addressedTo: [],
          emotion: "none",
        },
      },
    ],
  };
}

function fixture(
  channelType: ChannelType,
  read = false,
  custom?: ResponseHandlerFieldEvaluator,
) {
  const state: State = {
    values: { availableContexts: "general" },
    data: {},
    text: "",
  };
  if (read)
    state.data.providers = {
      userPersonalityPreferences: {
        text: "The complete authorized style reference: prefer concise prose, preserve explicit user preferences, and adapt tone to the current conversation.",
        discoveryText: "context_discovery: userPersonalityPreferences",
      },
    };
  const responses = read
    ? [response(["userPersonalityPreferences"]), response()]
    : [response()];
  const fields = registry(custom);
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000003" as UUID,
    character: {
      name: "Test Agent",
      system: "You are concise.",
      bio: "You help.",
    },
    actions: [],
    providers: read
      ? [{ name: "userPersonalityPreferences", get: vi.fn() }]
      : [],
    getService: vi.fn(() => null),
    getRoom: vi.fn(async () => null),
    getModelRegistrations: vi.fn(() => []),
    composeState: vi.fn(async () => structuredClone(state)),
    runActionsByMode: vi.fn(async () => undefined),
    emitEvent: vi.fn(async () => undefined),
    reportError: vi.fn(),
    getSetting: vi.fn(),
    useModel: vi.fn(async () => {
      const next = responses.shift();
      if (!next) throw new Error("Unexpected model call");
      return next;
    }),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
    },
    responseHandlerFieldRegistry: fields,
    responseHandlerFieldEvaluators: fields.list(),
    responseHandlerEvaluators: [],
  } as unknown as IAgentRuntime;
  const message: Memory = {
    id: "00000000-0000-0000-0000-000000000001" as UUID,
    entityId: "00000000-0000-0000-0000-000000000002" as UUID,
    agentId: runtime.agentId,
    roomId: "00000000-0000-0000-0000-000000000004" as UUID,
    content: { text: "Hello", source: "test", channelType },
    createdAt: 1,
  };
  return {
    runtime,
    state,
    message,
    responseId: message.id as UUID,
    stage1DecisionOnly: true,
  };
}

function requestSchemas(runtime: IAgentRuntime): JSONSchema[] {
  return vi.mocked(runtime.useModel).mock.calls.map(([, params]) => {
    const request = params as {
      tools: Array<{ name: string; parameters: JSONSchema }>;
    };
    const tool = request.tools.find((tool) => tool.name === "HANDLE_RESPONSE");
    if (!tool) throw new Error("Missing HANDLE_RESPONSE");
    return tool.parameters;
  });
}

afterEach(() => vi.restoreAllMocks());

describe("direct-text builtin schema descriptions", () => {
  it.each([ChannelType.DM, ChannelType.VOICE_DM])(
    "keeps every original for %s planning without asking the reply handler to select sources",
    async (channelType) => {
      const args = fixture(channelType);
      const originals = Array.from({ length: 24 }, (_, index) => ({
        ...args.message,
        id: `00000000-0000-0000-0001-${String(index).padStart(12, "0")}` as UUID,
        createdAt: index,
        content: { text: `Original ${index}: preserve  spaces\nand lines.` },
      }));
      args.state.data.providers = {
        RECENT_MESSAGES: { data: { recentMessages: originals } },
      };
      // A stale provider response must not reintroduce an unrequested selection.
      const stale = response();
      Object.assign(stale.toolCalls[0].arguments, {
        completionContext: {
          mode: "relevant_prior_dialogue",
          complete: true,
          sourceSetId: "current_request",
          relevantSourceIds: [],
          constraintSourceIds: [],
          referentSourceIds: [],
          pendingIntentSourceIds: [],
        },
      });
      vi.mocked(args.runtime.useModel).mockResolvedValueOnce(stale);
      const result = await runV5MessageRuntimeStage1(args);
      expect(result.kind).toBe("decision");
      if (result.kind !== "decision")
        throw new Error("Expected routing decision");
      expect(result.messageHandler.plan.completionContext).toBeUndefined();
      const [schema] = requestSchemas(args.runtime);
      expect(properties(schema).completionContext).toBeUndefined();
      expect(schema.required).not.toContain("completionContext");
      expect(properties(schema).replyText.type).toBe("array");
      expect(JSON.stringify(properties(schema).replyText)).not.toContain("hN");
      const modelInput = vi.mocked(args.runtime.useModel).mock.calls[0][1];
      const wire = JSON.stringify(modelInput.messages);
      for (const original of originals)
        expect(wire).toContain(
          JSON.stringify(original.content.text).slice(1, -1),
        );
      expect(wire).not.toContain("History source map");
      expect(wire).not.toContain("History selection:");
      const planning = await createV5MessageContextObject({
        runtime: args.runtime,
        message: args.message,
        state: args.state,
        providerPhase: "planning",
      });
      planning.metadata = {
        ...planning.metadata,
        completionContext: result.messageHandler.plan.completionContext,
      };
      const selected = selectCompletionContext(planning);
      expect(selected.applied).toBe(false);
      expect(selected.context).toBe(planning);
      expect(completionContextSources(selected.context).sources).toHaveLength(
        originals.length,
      );
    },
  );

  it("changes only the ten root descriptions, leaving canonical schemas and nested validation untouched", () => {
    const fields = registry();
    const original = fields.composeSchema();
    const snapshot = structuredClone(original);
    const projected = builtins.withDirectTextBuiltinSchemaDescriptions(
      original,
      fields.list(),
    );
    expect(projected).toEqual(expectedCompact(original));
    expect(original).toEqual(snapshot);
    expect(fields.composeSchema()).toBe(original);
    expect(properties(original).shouldRespond.description).toBe(
      builtins.shouldRespondFieldEvaluator.schema.description,
    );
    for (const name of [...removed, ...Object.keys(shortened)])
      expect(properties(original)[name].description).toBeTruthy();
    expect(properties(projected).relationships.items).toBe(
      properties(original).relationships.items,
    );
    expect(projected.required).toBe(original.required);
    expect(properties(projected).completionContext).toBe(
      properties(original).completionContext,
    );
    const inactive = withoutInactiveFields(projected, ["relationships"]);
    expect(properties(inactive).relationships).toBeUndefined();
    expect(properties(inactive).shouldRespond.description).toBeUndefined();
    expect(properties(projected).relationships.items).toBe(
      properties(original).relationships.items,
    );
  });

  it("preserves custom same-name registrations and separately replaced schema slices", () => {
    const custom = {
      ...builtins.shouldRespondFieldEvaluator,
      description: "Custom response policy.",
      schema: {
        ...builtins.shouldRespondFieldEvaluator.schema,
        description: "Custom schema policy.",
      },
    };
    const fields = registry(custom);
    const original = fields.composeSchema();
    const projected = builtins.withDirectTextBuiltinSchemaDescriptions(
      original,
      fields.list(),
    );
    expect(properties(projected).shouldRespond).toBe(custom.schema);
    expect(properties(projected).contexts.description).toBeUndefined();
    const replaced = {
      ...original,
      properties: {
        shouldRespond: { ...builtins.shouldRespondFieldEvaluator.schema },
      },
    };
    expect(
      builtins.withDirectTextBuiltinSchemaDescriptions(replaced, [
        builtins.shouldRespondFieldEvaluator,
      ]),
    ).toBe(replaced);
  });

  it.each([
    ChannelType.DM,
    ChannelType.GROUP,
    ChannelType.VOICE_DM,
    ChannelType.VOICE_GROUP,
  ])(
    "uses the correct schema in the production %s pipeline",
    async (channelType) => {
      const args = fixture(channelType);
      const canonical =
        args.runtime.responseHandlerFieldRegistry.composeSchema();
      const before = structuredClone(canonical);
      await runV5MessageRuntimeStage1(args);
      const [schema] = requestSchemas(args.runtime);
      expect(schema).toBeDefined();
      const expected = canonical;
      for (const name of [...removed, ...Object.keys(shortened)]) {
        if (
          name === "topics" &&
          channelType !== ChannelType.GROUP &&
          channelType !== ChannelType.VOICE_GROUP
        ) {
          expect(properties(schema).topics).toBeUndefined();
          expect(schema.required).not.toContain("topics");
        } else
          expect(properties(schema)[name]).toEqual(properties(expected)[name]);
      }
      expect(canonical).toEqual(before);
    },
  );

  it.each([ChannelType.DM, ChannelType.VOICE_DM])(
    "retains native contracts and custom fields across %s context reads",
    async (channelType) => {
      const custom = {
        ...builtins.factsFieldEvaluator,
        description: "Custom facts guidance.",
        schema: {
          ...builtins.factsFieldEvaluator.schema,
          description: "Custom facts contract.",
        },
      };
      const args = fixture(channelType, true, custom);
      const result = await runV5MessageRuntimeStage1(args);
      const schemas = requestSchemas(args.runtime);
      expect(schemas).toHaveLength(2);
      for (const schema of schemas) {
        expect(properties(schema).shouldRespond.description).toBe(
          properties(args.runtime.responseHandlerFieldRegistry.composeSchema())
            .shouldRespond.description,
        );
        expect(properties(schema).replyText.description).toBe(
          properties(args.runtime.responseHandlerFieldRegistry.composeSchema())
            .replyText.description,
        );
        expect(properties(schema).facts).toEqual(custom.schema);
      }
      expect(result.kind).toBe("decision");
    },
  );

  it("uses identical native tools and source-read decisions for text and voice", async () => {
    const text = fixture(ChannelType.DM, true);
    const voice = fixture(ChannelType.VOICE_DM, true);
    const textResult = await runV5MessageRuntimeStage1(text);
    const voiceResult = await runV5MessageRuntimeStage1(voice);
    expect(voiceResult.kind).toBe(textResult.kind);
    const tools = (runtime: IAgentRuntime) =>
      vi
        .mocked(runtime.useModel)
        .mock.calls.map(([, params]) => (params as { tools: unknown }).tools);
    expect(tools(voice.runtime)).toEqual(tools(text.runtime));
    const messages = (runtime: IAgentRuntime) =>
      vi
        .mocked(runtime.useModel)
        .mock.calls.map(([, params]) => params.messages);
    expect(messages(voice.runtime)).toEqual(messages(text.runtime));
    expect(requestSchemas(voice.runtime)).toHaveLength(2);
  });

  it.each([ChannelType.DM, ChannelType.VOICE_DM])(
    "repairs an empty answer once for %s",
    async (channelType) => {
      const args = fixture(channelType);
      const empty = response();
      empty.toolCalls[0].arguments.replyText = "";
      vi.mocked(args.runtime.useModel).mockResolvedValueOnce(empty);
      const result = await runV5MessageRuntimeStage1(args);
      expect(result.kind).toBe("decision");
      expect(args.runtime.useModel).toHaveBeenCalledTimes(2);
    },
  );

  it("does not project or call a model on the trusted coding path", async () => {
    const projection = vi.spyOn(
      builtins,
      "withDirectTextBuiltinSchemaDescriptions",
    );
    const args = fixture(ChannelType.DM);
    await runV5MessageRuntimeStage1({ ...args, codingMode: true });
    expect(projection).not.toHaveBeenCalled();
    expect(args.runtime.useModel).not.toHaveBeenCalled();
    expect(
      properties(args.runtime.responseHandlerFieldRegistry.composeSchema())
        .shouldRespond.description,
    ).toBe(builtins.shouldRespondFieldEvaluator.schema.description);
  });
});
