/** Regression for READ_CONTEXT(files, terminal): reject the read, repair routing once, never process its draft. */
import {
  ChannelType,
  ContextRegistry,
  type IAgentRuntime,
  type Memory,
  ResponseHandlerFieldRegistry,
  type State,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../../runtime/builtin-field-evaluators.ts";
import { runV5MessageRuntimeStage1 } from "./pipeline.ts";

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
});
