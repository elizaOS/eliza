import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
/** Regression for READ_CONTEXT(files, terminal): reject the read, repair routing once, never process its draft. */
import {
  ChannelType,
  COMPLETION_CONTEXT_SCHEMA,
  ContextRegistry,
  completionContextSources,
  type IAgentRuntime,
  type Memory,
  parseCompletionContextSelection,
  ResponseHandlerFieldRegistry,
  runWithStreamingContext,
  type State,
  selectCompletionContext,
  type UUID,
  withRequiredCompletionSourceIdentity,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  type JsonSchema,
  validateSchema,
} from "../../../../../packages/core/src/actions/validate-tool-args.ts";
import { requiredFixtureValue } from "../../../test/required-fixture-value.ts";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../../runtime/builtin-field-evaluators.ts";
import {
  createContextReadTool,
  extractContextRead,
  readContextRequests,
  withAvailableContextRequests,
} from "./context-discovery.ts";
import { withReviewedHistorySelection } from "./history-discovery.ts";
import {
  assertNativeContextReadToolBudget,
  decodeNativeContextReads,
  type NativeContextReadContract,
} from "./native-context-read.ts";
import { runV5MessageRuntimeStage1 } from "./pipeline.ts";
import { createSourceSelectionBinding } from "./source-selection-binding.ts";

const message: Memory = {
  id: "00000000-0000-4000-8000-000000000001" as UUID,
  entityId: "00000000-0000-4000-8000-000000000002" as UUID,
  agentId: "00000000-0000-4000-8000-000000000003" as UUID,
  roomId: "00000000-0000-4000-8000-000000000004" as UUID,
  content: {
    text: "Read the requested file.",
    source: "client_chat",
    channelType: ChannelType.DM,
  },
  createdAt: 1,
};
// Current Stage 1 admits CHOICE; domain providers such as NAMED_NOTES wait for planning.
const providerText = "Complete authorized guide, not yet requested. ".repeat(
  20,
);
const read = (references: unknown, extra = {}) => ({
  text: "",
  toolCalls: [
    {
      name: "READ_CONTEXT",
      arguments: {
        contextRequests: references,
        acknowledgment: "Let me pull that file.",
        ...extra,
      },
    },
  ],
});
const decision = {
  text: "",
  toolCalls: [
    {
      name: "HANDLE_RESPONSE",
      arguments: {
        shouldRespond: "RESPOND",
        contexts: ["files"],
        contextRequests: [],
        intents: ["Read the requested file"],
        candidateActionNames: ["FILE_READ"],
        replyText: "Let me check.",
        replyEffectStatus: "pending",
        facts: [],
        relationships: [],
        topics: [],
        addressedTo: [],
        emotion: "none",
      },
    },
  ],
};

function fixture(responses: unknown[]) {
  const state: State = {
    values: {},
    text: "",
    data: {
      providers: {
        CHOICE: {
          text: providerText,
          discoveryText: "context_discovery: CHOICE",
        },
      },
    },
  };
  const fields = new ResponseHandlerFieldRegistry();
  for (const field of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS)
    fields.register(field);
  const dispatch = vi.spyOn(fields, "dispatch");
  const useModel = vi.fn(async () => {
    if (!responses.length) throw new Error("Unbounded model retry");
    expect(dispatch).not.toHaveBeenCalled();
    return responses.shift();
  });
  const composeState = vi.fn(async () => structuredClone(state));
  const action = vi.fn(async () => ({ success: true }));
  const runtime = {
    agentId: message.agentId,
    character: {
      name: "Test agent",
      system: "Follow the user's request.",
      bio: "",
    },
    contexts: new ContextRegistry([
      { id: "general", description: "General tasks" },
      { id: "files", description: "File operations" },
    ]),
    actions: [
      {
        name: "FILE_READ",
        description: "Read an authorized file",
        validate: async () => true,
        handler: action,
      },
    ],
    providers: [{ name: "CHOICE", get: vi.fn() }],
    evaluators: [],
    getService: vi.fn(() => null),
    getRoom: vi.fn(async () => null),
    getModelRegistrations: vi.fn(() => []),
    getSetting: vi.fn(),
    composeState,
    useModel,
    runActionsByMode: vi.fn(async () => undefined),
    emitEvent: vi.fn(async () => undefined),
    reportError: vi.fn(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
    },
    responseHandlerFieldRegistry: fields,
    responseHandlerFieldEvaluators: [
      ...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
    ],
    responseHandlerEvaluators: [],
  } as unknown as IAgentRuntime;
  return { runtime, state, dispatch, useModel, composeState, action };
}

describe("invalid context read recovery", () => {
  it.each([false, true])(
    "keeps context reads strict and host-nonempty with acknowledgment=%s",
    (acknowledgment) => {
      const schema = {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          contextRequests: {
            type: "array" as const,
            items: { type: "string" as const, enum: ["CHOICE"] },
          },
        },
        required: ["contextRequests"],
      };
      const tool = createContextReadTool(schema, acknowledgment);
      expect(tool?.strict).toBe(true);
      expect(tool?.parameters?.properties?.contextRequests).toEqual(
        schema.properties.contextRequests,
      );
      expect(tool?.parameters?.additionalProperties).toBe(false);
      const call = (references: string[]) => ({
        text: "",
        toolCalls: [
          {
            name: "READ_CONTEXT",
            arguments: {
              contextRequests: references,
              ...(acknowledgment
                ? { acknowledgment: "Reading authorized context." }
                : {}),
            },
          },
        ],
      });
      expect(() => extractContextRead(call([]), true)).toThrow(
        expect.objectContaining({ code: "CONTEXT_DISCOVERY_INVALID_READ" }),
      );
      expect(
        extractContextRead(call(["CHOICE"]), true)?.contextRequests,
      ).toEqual(["CHOICE"]);
      expect(() =>
        readContextRequests(
          { contextRequests: ["forged"] },
          new Set(["CHOICE"]),
        ),
      ).toThrow(
        expect.objectContaining({ code: "CONTEXT_DISCOVERY_INVALID_REQUEST" }),
      );
    },
  );

  it("projects exact authorized history identities without changing host selection or repair subsets", () => {
    const context = {
      id: "turn",
      metadata: { roomId: "room", messageId: "turn" },
      events: [1, 2].map((i) => ({
        id: `prior-${i}`,
        type: "segment" as const,
        source: "prior-dialogue",
        segment: {
          id: `prior-${i}`,
          label: "prior_message:user",
          content: `Synthetic original ${i}.`,
          stable: false,
        },
      })),
    };
    const snapshot = completionContextSources(context);
    const schema = {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        completionContext: COMPLETION_CONTEXT_SCHEMA,
        contextRequests: {
          type: "array" as const,
          items: { type: "string" as const },
        },
      },
      required: ["completionContext", "contextRequests"],
    };
    const original = structuredClone(schema);
    const irrelevantContext = new Proxy(context, {
      get() {
        throw new Error("Irrelevant source access");
      },
    });
    const noSelection = { type: "object" as const, properties: {} };
    expect(
      withRequiredCompletionSourceIdentity(noSelection, irrelevantContext),
    ).toBe(noSelection);
    const wrongIdentityType = {
      ...schema,
      properties: {
        ...schema.properties,
        completionContext: {
          ...COMPLETION_CONTEXT_SCHEMA,
          properties: {
            ...COMPLETION_CONTEXT_SCHEMA.properties,
            sourceSetId: { type: "number" as const },
          },
        },
      },
    };
    expect(
      withRequiredCompletionSourceIdentity(
        wrongIdentityType,
        irrelevantContext,
      ),
    ).toBe(wrongIdentityType);
    for (const repair of [false, true]) {
      for (const allowed of [
        [snapshot.sourceSetId],
        [snapshot.sourceSetId, "stale"],
      ]) {
        const restricted = {
          ...schema,
          properties: {
            ...schema.properties,
            completionContext: {
              ...COMPLETION_CONTEXT_SCHEMA,
              properties: {
                ...COMPLETION_CONTEXT_SCHEMA.properties,
                sourceSetId: { type: "string" as const, enum: allowed },
              },
            },
          },
        };
        expect(
          withRequiredCompletionSourceIdentity(restricted, context, repair)
            .properties?.completionContext?.properties?.sourceSetId?.enum,
        ).toEqual([snapshot.sourceSetId]);
      }
      for (const denied of [[], ["stale"]]) {
        const restricted = {
          ...schema,
          properties: {
            ...schema.properties,
            completionContext: {
              ...COMPLETION_CONTEXT_SCHEMA,
              properties: {
                ...COMPLETION_CONTEXT_SCHEMA.properties,
                sourceSetId: { type: "string" as const, enum: denied },
              },
            },
          },
        };
        expect(() =>
          withRequiredCompletionSourceIdentity(restricted, context, repair),
        ).toThrow(
          expect.objectContaining({
            code: "COMPLETION_CONTEXT_IDENTITY_CONFLICT",
          }),
        );
      }
    }
    for (const repair of [undefined, [], ["h2"]]) {
      const reviewed = withReviewedHistorySelection(schema, true, repair);
      const projected = withRequiredCompletionSourceIdentity(
        reviewed,
        context,
        repair !== undefined,
      );
      const selection = projected.properties?.completionContext;
      expect(selection?.properties?.sourceSetId).toMatchObject({
        type: "string",
        enum: [snapshot.sourceSetId],
      });
      expect(selection?.properties?.sourceSetId).not.toHaveProperty("pattern");
      for (const key of [
        "relevantSourceIds",
        "constraintSourceIds",
        "referentSourceIds",
        "pendingIntentSourceIds",
      ]) {
        const list = selection?.properties?.[key];
        expect(list?.items).not.toHaveProperty("pattern");
        expect(list?.items).toMatchObject({
          type: "string",
          enum: repair?.length ? repair : ["h1", "h2"],
        });
        if (repair?.length === 0) expect(list?.enum).toEqual([[]]);
      }
      expect(selection?.additionalProperties).toBe(false);
      expect(projected.properties?.contextRequests).toEqual(
        reviewed.properties?.contextRequests,
      );
      if (repair === undefined)
        expect(
          createSourceSelectionBinding(projected, context)?.parameters
            .properties?.completionContext?.properties?.sourceSetId?.enum,
        ).toEqual(["current_request"]);
    }
    expect(schema).toEqual(original);
    const selection = {
      mode: "selected",
      sourceSetId: snapshot.sourceSetId,
      complete: true,
      relevantSourceIds: ["h1"],
      constraintSourceIds: [],
      referentSourceIds: [],
      pendingIntentSourceIds: [],
    };
    expect(parseCompletionContextSelection(selection)).toEqual(selection);
    const selected = selectCompletionContext({
      ...context,
      metadata: { ...context.metadata, completionContext: selection },
    });
    expect(selected.applied).toBe(true);
    expect(selected.context.events).toEqual([context.events[0]]);
    for (const invalid of [
      { ...selection, sourceSetId: "stale" },
      { ...selection, relevantSourceIds: ["h999"] },
      { ...selection, relevantSourceIds: ["forged"] },
      { ...selection, relevantSourceIds: ["h1", "h1"] },
    ]) {
      const originalContext = {
        ...context,
        metadata: { ...context.metadata, completionContext: invalid },
      };
      const refused = selectCompletionContext(originalContext);
      expect(refused.applied).toBe(false);
      expect(refused.context).toBe(originalContext);
      expect(refused.context.events).toEqual(context.events);
    }
  });
  it("offers no context read when this turn has no authorized references", async () => {
    const { contextRequests: _requests, ...argumentsWithoutRead } =
      decision.toolCalls[0].arguments;
    const reply = {
      ...decision,
      toolCalls: [
        { ...decision.toolCalls[0], arguments: argumentsWithoutRead },
      ],
    };
    const f = fixture([reply]);
    f.state.data = { ...f.state.data, providers: {} };
    f.runtime.providers = [];
    const result = await runV5MessageRuntimeStage1({
      runtime: f.runtime,
      state: f.state,
      message,
      responseId: "00000000-0000-4000-8000-000000000005" as UUID,
      stage1DecisionOnly: true,
    });
    expect(result.kind).toBe("decision");
    const tools = (
      f.useModel.mock.calls[0] as unknown as [
        unknown,
        {
          tools: Array<{
            name: string;
            strict: boolean;
            parameters: {
              properties: Record<string, unknown>;
              required: string[];
              additionalProperties: boolean;
            };
          }>;
        },
      ]
    )[1].tools;
    const handle = tools.find((tool) => tool.name === "HANDLE_RESPONSE");
    expect(handle?.strict).toBe(true);
    expect(handle?.parameters.additionalProperties).toBe(false);
    expect(handle?.parameters.properties).not.toHaveProperty("contextRequests");
    expect(handle?.parameters.required).not.toContain("contextRequests");
    expect(tools.some((tool) => tool.name === "READ_CONTEXT")).toBe(false);
    expect(readContextRequests({}, new Set())).toEqual([]);
    expect(() =>
      readContextRequests({ contextRequests: ["unadvertised"] }, new Set()),
    ).toThrow(
      expect.objectContaining({ code: "CONTEXT_DISCOVERY_INVALID_REQUEST" }),
    );
    expect(f.useModel).toHaveBeenCalledTimes(1);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.action).not.toHaveBeenCalled();
  });

  it("keeps available-reference constraints and rejects names outside this turn", () => {
    const schema = {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        contextRequests: {
          type: "array" as const,
          items: { type: "string" as const, enum: ["CHOICE", "other"] },
        },
        replyText: { type: "string" as const },
      },
      required: ["contextRequests", "replyText"],
    };
    const projected = withAvailableContextRequests(schema, new Set(["CHOICE"]));
    expect(projected).toEqual({
      ...schema,
      properties: {
        ...schema.properties,
        contextRequests: {
          ...schema.properties.contextRequests,
          items: { type: "string", enum: ["CHOICE"] },
        },
      },
    });
    expect(createContextReadTool(projected)).toBeDefined();
    expect(
      readContextRequests({ contextRequests: ["CHOICE"] }, new Set(["CHOICE"])),
    ).toEqual(["CHOICE"]);
    expect(() =>
      readContextRequests({ contextRequests: ["other"] }, new Set(["CHOICE"])),
    ).toThrow(
      expect.objectContaining({ code: "CONTEXT_DISCOVERY_INVALID_REQUEST" }),
    );
    expect(schema.properties.contextRequests.items.enum).toEqual([
      "CHOICE",
      "other",
    ]);
    expect(
      createContextReadTool(withAvailableContextRequests(schema, new Set())),
    ).toBeUndefined();
  });
  it.each([ChannelType.DM, ChannelType.VOICE_DM])(
    "repairs unavailable references without reading providers or running effects on %s",
    async (channelType) => {
      const f = fixture([read(["files", "terminal"]), decision]);
      const result = await runV5MessageRuntimeStage1({
        runtime: f.runtime,
        state: f.state,
        message: { ...message, content: { ...message.content, channelType } },
        responseId: "00000000-0000-4000-8000-000000000005" as UUID,
        stage1DecisionOnly: true,
      });
      expect(result.kind).toBe("decision");
      if (result.kind === "decision")
        expect(result.messageHandler.plan.candidateActions).toContain(
          "FILE_READ",
        );
      expect(f.useModel).toHaveBeenCalledTimes(2);
      expect(f.dispatch).toHaveBeenCalledTimes(1);
      expect(f.composeState).not.toHaveBeenCalled();
      expect(f.action).not.toHaveBeenCalled();
      const repair = JSON.stringify(f.useModel.mock.calls[1]);
      expect(repair).toContain("context_read_repair");
      expect(repair).toContain("CHOICE");
      expect(repair).not.toContain(providerText.trim());
    },
  );

  it("fails closed after one correction if the references remain invalid", async () => {
    const f = fixture([read(["files"]), read(["terminal"])]);
    await expect(
      runV5MessageRuntimeStage1({
        runtime: f.runtime,
        state: f.state,
        message,
        responseId: "00000000-0000-4000-8000-000000000005" as UUID,
        stage1DecisionOnly: true,
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_DISCOVERY_INVALID_REQUEST" });
    expect(f.useModel).toHaveBeenCalledTimes(2);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.composeState).not.toHaveBeenCalled();
    expect(f.action).not.toHaveBeenCalled();
  });

  it("does not process fields smuggled into an invalid read", async () => {
    const f = fixture([
      read(["CHOICE"], { facts: ["Do not persist this"] }),
      decision,
    ]);
    await runV5MessageRuntimeStage1({
      runtime: f.runtime,
      state: f.state,
      message,
      responseId: "00000000-0000-4000-8000-000000000005" as UUID,
      stage1DecisionOnly: true,
    });
    expect(f.useModel).toHaveBeenCalledTimes(2);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.dispatch.mock.calls)).not.toContain(
      "Do not persist this",
    );
    expect(f.composeState).not.toHaveBeenCalled();
  });
  it("allows a corrected authorized read through fresh composition", async () => {
    const f = fixture([read(["files"]), read(["CHOICE"]), decision]);
    await runV5MessageRuntimeStage1({
      runtime: f.runtime,
      state: f.state,
      message,
      responseId: "00000000-0000-4000-8000-000000000005" as UUID,
      stage1DecisionOnly: true,
    });
    expect(f.useModel).toHaveBeenCalledTimes(3);
    expect(f.composeState).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.useModel.mock.calls[1])).not.toContain(
      providerText,
    );
    expect(JSON.stringify(f.useModel.mock.calls[2])).toContain(
      providerText.trim(),
    );
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.action).not.toHaveBeenCalled();
  });

  it("does not spend another call on a truncated invalid read", async () => {
    const f = fixture([{ ...read(["files"]), finishReason: "length" }]);
    await expect(
      runV5MessageRuntimeStage1({
        runtime: f.runtime,
        state: f.state,
        message,
        responseId: "00000000-0000-4000-8000-000000000005" as UUID,
        stage1DecisionOnly: true,
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_DISCOVERY_INVALID_REQUEST" });
    expect(f.useModel).toHaveBeenCalledTimes(1);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "records each completed call before rejection, including empty retry=%s",
    async (emptyRetry) => {
      const directory = await mkdtemp(
        join(tmpdir(), "stage1-invalid-read-recording-"),
      );
      vi.stubEnv("ELIZA_TRAJECTORY_RECORDING", "1");
      vi.stubEnv("ELIZA_TRAJECTORY_DIR", directory);
      vi.stubEnv("ELIZA_AWAIT_FACTS_STAGE", "true");
      const rejected = {
        ...read(["files"]),
        usage: { promptTokens: 101, completionTokens: 7, totalTokens: 108 },
      };
      const f = fixture([
        ...(emptyRetry
          ? [
              {
                text: "",
                usage: {
                  promptTokens: 89,
                  completionTokens: 2,
                  totalTokens: 91,
                },
              },
            ]
          : []),
        rejected,
        rejected,
      ]);
      try {
        await expect(
          runV5MessageRuntimeStage1({
            runtime: f.runtime,
            state: f.state,
            message,
            responseId: "00000000-0000-4000-8000-000000000005" as UUID,
            stage1DecisionOnly: true,
          }),
        ).rejects.toMatchObject({ code: "CONTEXT_DISCOVERY_INVALID_REQUEST" });
        const files = (await readdir(directory, { recursive: true })).filter(
          (name) => name.endsWith(".json"),
        );
        expect(files).toHaveLength(1);
        const file = files[0];
        if (!file) throw new Error("Trajectory file missing");
        const trajectory = JSON.parse(
          await readFile(join(directory, file), "utf8"),
        );
        expect(trajectory.status).toBe("errored");
        expect(trajectory.stages).toHaveLength(emptyRetry ? 3 : 2);
        expect(
          new Set(
            trajectory.stages.map(
              (stage: { stageId: string }) => stage.stageId,
            ),
          ).size,
        ).toBe(trajectory.stages.length);
        expect(trajectory.metrics.totalPromptTokens).toBe(
          emptyRetry ? 291 : 202,
        );
        for (const [index, stage] of trajectory.stages.entries()) {
          const call = f.useModel.mock.calls[index] as unknown as [
            unknown,
            { messages: unknown; tools: unknown },
          ];
          expect(stage.model.messages).toEqual(call[1].messages);
          expect(stage.model.tools).toEqual(call[1].tools);
        }
        expect(
          trajectory.stages.at(-1).model.toolCalls[0].args.contextRequests,
        ).toEqual(["files"]);
        expect(trajectory.stages.at(-1).model.usage.promptTokens).toBe(101);
        expect(f.dispatch).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
  it.each(["transport", "inflight-abort", "pre-abort", "falsy-throw"])(
    "records honest semantic failure evidence for %s",
    async (mode) => {
      const directory = await mkdtemp(
        join(tmpdir(), "stage1-failed-recording-"),
      );
      vi.stubEnv("ELIZA_TRAJECTORY_RECORDING", "1");
      vi.stubEnv("ELIZA_TRAJECTORY_DIR", directory);
      vi.stubEnv("ELIZA_AWAIT_FACTS_STAGE", "true");
      const f = fixture([]);
      const controller = new AbortController();
      const failure =
        mode === "falsy-throw"
          ? 0
          : mode === "transport"
            ? new Error("transport failed secret-fixture")
            : new DOMException("cancelled secret-fixture", "AbortError");
      f.runtime.redactSecrets = (text) =>
        text.replaceAll("secret-fixture", "[REDACTED]");
      f.runtime.getLastResolvedModelProvider = vi.fn(() => "stale-provider");
      if (mode === "pre-abort") controller.abort(failure);
      f.useModel.mockImplementation(async () => {
        if (mode === "inflight-abort") controller.abort(failure);
        throw failure;
      });
      try {
        await expect(
          runWithStreamingContext(
            {
              messageId: "failed-stage",
              abortSignal: controller.signal,
            },
            () =>
              runV5MessageRuntimeStage1({
                runtime: f.runtime,
                state: f.state,
                message,
                responseId: "00000000-0000-4000-8000-000000000005" as UUID,
                stage1DecisionOnly: true,
              }),
          ),
        ).rejects.toBe(failure);
        const files = (await readdir(directory, { recursive: true })).filter(
          (name) => name.endsWith(".json"),
        );
        expect(files).toHaveLength(1);
        const file = files[0];
        if (!file) throw new Error("Trajectory file missing");
        const trajectory = JSON.parse(
          await readFile(join(directory, file), "utf8"),
        );
        expect(trajectory.status).toBe("errored");
        if (mode === "pre-abort") {
          expect(f.useModel).not.toHaveBeenCalled();
          expect(trajectory.stages).toHaveLength(0);
        } else {
          expect(f.useModel).toHaveBeenCalledTimes(1);
          expect(trajectory.stages).toHaveLength(1);
          const stage = trajectory.stages[0];
          const call = f.useModel.mock.calls[0] as unknown as [
            unknown,
            { messages: unknown; tools: unknown },
          ];
          expect(stage.kind).toBe("messageHandler");
          expect(stage.model.messages).toEqual(call[1].messages);
          expect(stage.model.tools).toEqual(call[1].tools);
          expect(stage.model.finishReason).toBe("error");
          expect(stage.model.response).toContain(
            "[messageHandler stage failed]",
          );
          expect(stage.model.response).toContain(
            mode === "falsy-throw" ? "0" : "[REDACTED]",
          );
          expect(stage.model.response).not.toContain("secret-fixture");
          for (const field of [
            "modelName",
            "provider",
            "usage",
            "toolCalls",
            "costUsd",
          ]) {
            expect(stage.model[field]).toBeUndefined();
          }
        }
        expect(f.dispatch).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

describe("typed native context read contract", () => {
  const baseSchema = {
    type: "object",
    properties: {
      contextRequests: { type: "array", items: { type: "string" } },
    },
    required: ["contextRequests"],
  };
  function bound() {
    let current = true;
    const contract: NativeContextReadContract = {
      providers: new Set(["VISIBLE", "h3"]),
      history: {
        sourceSetId: "a".repeat(64),
        sources: new Map([
          [1, "history:h1"],
          [3, "history:h3"],
          [551, "history:h551"],
        ]),
        all: "history:all",
        assertCurrent() {
          if (!current) throw new Error("stale binding");
        },
        search(scope, query) {
          return (
            (scope === "all"
              ? "history:search:"
              : scope === "user"
                ? "history:search-user:"
                : "history:search-assistant:") + query
          );
        },
      },
    };
    return {
      contract,
      stale() {
        current = false;
      },
    };
  }
  it("keeps constructor, native schema and existing read language coherent without a broad string branch", () => {
    const { contract } = bound();
    const tool = requiredFixtureValue(
      createContextReadTool(baseSchema, true, contract),
    );
    expect(tool.name).toBe("READ_CONTEXT");
    expect(tool.parameters).toHaveProperty("properties.reads");
    expect(tool.parameters).not.toHaveProperty("properties.contextRequests");
    const query = " \n café:会議\t ";
    const reads = [
      { kind: "provider", references: ["VISIBLE", "h3"] },
      {
        kind: "history-source",
        sourceSetId: requiredFixtureValue(contract.history).sourceSetId,
        sourceOrdinals: [551, 3],
      },
      {
        kind: "history-search",
        sourceSetId: requiredFixtureValue(contract.history).sourceSetId,
        speaker: "assistant",
        query,
      },
    ];
    const errors: string[] = [];
    validateSchema(
      tool.parameters as JsonSchema,
      { reads, acknowledgment: "" },
      "",
      errors,
    );
    expect(errors).toEqual([]);
    expect(decodeNativeContextReads(reads, contract)).toEqual([
      "VISIBLE",
      "h3",
      "history:h551",
      "history:h3",
      "history:search-assistant:" + query,
    ]);
    assertNativeContextReadToolBudget([tool]);
    const holeErrors: string[] = [];
    validateSchema(
      tool.parameters as JsonSchema,
      {
        reads: [
          {
            kind: "history-source",
            sourceSetId: requiredFixtureValue(contract.history).sourceSetId,
            sourceOrdinals: [2],
          },
        ],
        acknowledgment: "",
      },
      "",
      holeErrors,
    );
    expect(holeErrors.length).toBeGreaterThan(0);
  });
  it.each(
    [
      [{ kind: "provider", references: ["calendar"] }],
      [{ kind: "provider", references: [] }],
      [{ kind: "history-source", sourceSetId: "wrong", sourceOrdinals: [1] }],
      [
        {
          kind: "history-source",
          sourceSetId: "a".repeat(64),
          sourceOrdinals: [2],
        },
      ],
      [
        {
          kind: "history-source",
          sourceSetId: "a".repeat(64),
          sourceOrdinals: ["3"],
        },
      ],
      [
        {
          kind: "history-source",
          sourceSetId: "a".repeat(64),
          sourceOrdinals: [0, 1.5, Number.MAX_SAFE_INTEGER + 1],
        },
      ],
      [
        {
          kind: "history-search",
          sourceSetId: "a".repeat(64),
          speaker: "all",
          query: " \n\t",
        },
      ],
      [
        {
          kind: "history-all",
          sourceSetId: "a".repeat(64),
          extra: "not admitted",
        },
      ],
    ].map((reads) => ({ reads })),
  )(
    "rejects malformed, unoffered or stale selectors before any field effects: %j",
    ({ reads }) => {
      const { contract } = bound();
      expect(() => decodeNativeContextReads(reads, contract)).toThrowError(
        expect.objectContaining({ code: "CONTEXT_DISCOVERY_INVALID_READ" }),
      );
    },
  );
  it.each([
    { type: "array", items: { type: "string", enum: ["VISIBLE"] } },
    { type: "array", items: { type: "string", pattern: "^VISIBLE$" } },
    { type: "array", items: { type: "string" }, maxItems: 1 },
    { type: "array", items: { type: "string" }, minItems: 1 },
    { type: "array", items: { type: "string" }, uniqueItems: true },
  ])(
    "retains custom string-list constraints instead of silently replacing them: %j",
    (requests) => {
      const schema = {
        ...baseSchema,
        properties: { contextRequests: requests },
      };
      const legacy = createContextReadTool(schema);
      expect(
        requiredFixtureValue(
          requiredFixtureValue(requiredFixtureValue(legacy).parameters)
            .properties,
        ).contextRequests,
      ).toEqual(requests);
      expect(
        createContextReadTool(schema, false, bound().contract),
      ).toBeUndefined();
    },
  );
  it("uses only the existing single correction budget for repeated invalid typed reads", async () => {
    const invalid = () => ({
      text: "",
      toolCalls: [
        {
          name: "READ_CONTEXT",
          arguments: {
            reads: [{ kind: "provider", references: ["calendar"] }],
            acknowledgment: "",
          },
        },
      ],
    });
    const f = fixture([invalid(), invalid()]);
    await expect(
      runV5MessageRuntimeStage1({
        runtime: f.runtime,
        state: f.state,
        message,
        responseId: "00000000-0000-4000-8000-000000000005" as UUID,
        stage1DecisionOnly: true,
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_DISCOVERY_INVALID_READ" });
    expect(f.useModel).toHaveBeenCalledTimes(2);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.composeState).not.toHaveBeenCalled();
    expect(f.action).not.toHaveBeenCalled();
  });
  it("keeps legacy input decoding behind the same exact offered-reference validator", () => {
    const contract = bound().contract;
    const legacy = (contextRequests: string[]) => ({
      text: "",
      toolCalls: [{ name: "READ_CONTEXT", arguments: { contextRequests } }],
    });
    expect(
      readContextRequests(
        requiredFixtureValue(
          extractContextRead(legacy(["VISIBLE"]), true, contract),
        ),
        contract.providers,
      ),
    ).toEqual(["VISIBLE"]);
    for (const value of ["calendar", "history:3", "3"]) {
      expect(() =>
        readContextRequests(
          requiredFixtureValue(
            extractContextRead(legacy([value]), true, contract),
          ),
          contract.providers,
        ),
      ).toThrowError(
        expect.objectContaining({ code: "CONTEXT_DISCOVERY_INVALID_REQUEST" }),
      );
    }
  });
  it("retains source currentness and refuses mixed old/new control fields", () => {
    const f = bound();
    f.stale();
    expect(() =>
      decodeNativeContextReads(
        [
          {
            kind: "history-all",
            sourceSetId: requiredFixtureValue(f.contract.history).sourceSetId,
          },
        ],
        f.contract,
      ),
    ).toThrow("stale binding");
    expect(() =>
      extractContextRead(
        {
          text: "",
          toolCalls: [
            {
              name: "READ_CONTEXT",
              arguments: {
                reads: [{ kind: "provider", references: ["VISIBLE"] }],
                contextRequests: ["VISIBLE"],
              },
            },
          ],
        },
        true,
        bound().contract,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "CONTEXT_DISCOVERY_INVALID_READ" }),
    );
    expect(
      createContextReadTool(baseSchema, false, { providers: new Set() }),
    ).toBeUndefined();
  });
  it("rejects unsupported complete schemas rather than dropping provider references", () => {
    const providers = new Set(
      Array.from({ length: 501 }, (_, n) => `REF_${n}`),
    );
    const tool = requiredFixtureValue(
      createContextReadTool(baseSchema, false, { providers }),
    );
    expect(() => assertNativeContextReadToolBudget([tool])).toThrowError(
      expect.objectContaining({ code: "CONTEXT_DISCOVERY_SCHEMA_UNSUPPORTED" }),
    );
    expect(providers.size).toBe(501);
  });
  it("uses the same two model rounds and existing provider read barrier for a valid typed read", async () => {
    const f = fixture([
      {
        text: "",
        toolCalls: [
          {
            name: "READ_CONTEXT",
            arguments: {
              reads: [{ kind: "provider", references: ["CHOICE"] }],
              acknowledgment: "",
            },
          },
        ],
      },
      decision,
    ]);
    const result = await runV5MessageRuntimeStage1({
      runtime: f.runtime,
      state: f.state,
      message,
      responseId: "00000000-0000-4000-8000-000000000005" as UUID,
      stage1DecisionOnly: true,
    });
    expect(result.kind).toBe("decision");
    expect(f.useModel).toHaveBeenCalledTimes(2);
    expect(f.composeState).toHaveBeenCalledTimes(1);
    expect(f.action).not.toHaveBeenCalled();
    const first = f.useModel.mock.calls[0] as unknown as [
      unknown,
      { tools: Array<{ name: string; parameters: unknown }> },
    ];
    expect(
      requiredFixtureValue(
        first[1].tools.find((t) => t.name === "READ_CONTEXT"),
      ).parameters,
    ).toHaveProperty("properties.reads");
  });
});

describe("builtin request-local completion ordinals", () => {
  function selectionFixture() {
    const context = {
      id: "turn",
      metadata: { roomId: "room", messageId: "turn" },
      events: [1, 2, 3].map((i) => ({
        id: `prior-${i}`,
        type: "segment" as const,
        source: "prior-dialogue",
        segment: {
          id: `prior-${i}`,
          label: "prior_message:user",
          content: `Original ${i}.`,
          stable: false,
        },
      })),
    };
    const schema = {
      type: "object" as const,
      properties: { completionContext: COMPLETION_CONTEXT_SCHEMA },
    };
    const bound = withRequiredCompletionSourceIdentity(schema, context);
    const completion = requiredFixtureValue(
      requiredFixtureValue(bound.properties).completionContext,
    );
    const original = requiredFixtureValue(
      requiredFixtureValue(completion.properties).constraintSourceIds,
    );
    const sparse = {
      ...bound,
      properties: {
        ...bound.properties,
        completionContext: {
          ...completion,
          properties: {
            ...completion.properties,
            constraintSourceIds: {
              ...original,
              items: { type: "string" as const, enum: ["h1", "h3"] },
            },
          },
        },
      },
    };
    const assertCurrent = vi.fn();
    const binding = requiredFixtureValue(
      createSourceSelectionBinding(sparse, context, {
        sourceOrdinals: true,
        assertCurrent,
      }),
    );
    const selection = {
      mode: "relevant_prior_dialogue",
      sourceSetId: "current_request",
      complete: true,
      relevantSourceIds: [1, 2, 3],
      constraintSourceIds: [3],
      referentSourceIds: [],
      pendingIntentSourceIds: [],
    };
    const response = (value: unknown) => ({
      text: "",
      toolCalls: [
        { name: "HANDLE_RESPONSE", arguments: { completionContext: value } },
      ],
    });
    return { context, sparse, binding, assertCurrent, selection, response };
  }
  it("decodes only exact per-field ordinals to canonical strings and preserves sparse repair subsets", () => {
    const f = selectionFixture();
    const resolved = f.binding.resolve(f.response(f.selection)) as {
      toolCalls: Array<{ arguments: { completionContext: unknown } }>;
    };
    expect(
      requiredFixtureValue(resolved.toolCalls[0]).arguments.completionContext,
    ).toEqual({
      ...f.selection,
      sourceSetId: completionContextSources(f.context).sourceSetId,
      relevantSourceIds: ["h1", "h2", "h3"],
      constraintSourceIds: ["h3"],
    });
    expect(f.assertCurrent).toHaveBeenCalledTimes(1);
    for (const sourceSetId of [
      "wrong",
      completionContextSources(f.context).sourceSetId,
    ]) {
      expect(() =>
        f.binding.resolve(f.response({ ...f.selection, sourceSetId })),
      ).toThrowError(
        expect.objectContaining({ code: "COMPLETION_CONTEXT_INVALID_ORDINAL" }),
      );
    }
    for (const value of [
      [2],
      ["3"],
      [0],
      [1.5],
      [Number.MAX_SAFE_INTEGER + 1],
      [1, "3"],
      [3, 3],
    ]) {
      expect(() =>
        f.binding.resolve(
          f.response({ ...f.selection, constraintSourceIds: value }),
        ),
      ).toThrowError(
        expect.objectContaining({ code: "COMPLETION_CONTEXT_INVALID_ORDINAL" }),
      );
    }
  });
  it("keeps default/custom constraints unchanged and checks freshness before resolving", () => {
    const f = selectionFixture();
    const legacy = requiredFixtureValue(
      createSourceSelectionBinding(f.sparse, f.context),
    );
    expect(
      requiredFixtureValue(
        requiredFixtureValue(
          requiredFixtureValue(
            requiredFixtureValue(legacy.parameters.properties)
              .completionContext,
          ).properties,
        ).constraintSourceIds,
      ).items,
    ).toMatchObject({ type: "string", enum: ["h1", "h3"] });
    const complete = requiredFixtureValue(
      requiredFixtureValue(f.sparse.properties).completionContext,
    );
    const custom = {
      ...f.sparse,
      properties: {
        ...f.sparse.properties,
        completionContext: {
          ...complete,
          properties: {
            ...complete.properties,
            relevantSourceIds: {
              ...requiredFixtureValue(complete.properties).relevantSourceIds,
              minItems: 1,
            },
          },
        },
      },
    };
    const fallback = requiredFixtureValue(
      createSourceSelectionBinding(custom, f.context, {
        sourceOrdinals: true,
        assertCurrent() {},
      }),
    );
    expect(
      requiredFixtureValue(
        requiredFixtureValue(
          requiredFixtureValue(fallback.parameters.properties)
            .completionContext,
        ).properties,
      ).relevantSourceIds,
    ).toMatchObject({ minItems: 1, items: { type: "string" } });
    f.assertCurrent.mockImplementation(() => {
      throw new Error("revoked");
    });
    expect(() => f.binding.resolve(f.response(f.selection))).toThrow("revoked");
    f.assertCurrent.mockReset();
    expect(() =>
      f.binding.resolve(f.response({ ...f.selection, unexpected: true })),
    ).toThrowError(
      expect.objectContaining({ code: "COMPLETION_CONTEXT_INVALID_ORDINAL" }),
    );
  });
});
