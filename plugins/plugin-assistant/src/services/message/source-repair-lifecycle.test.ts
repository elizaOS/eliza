import {
  ChannelType,
  ContextRegistry,
  type IAgentRuntime,
  type Memory,
  ResponseHandlerFieldRegistry,
  runWithStreamingContext,
  type State,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../../runtime/builtin-field-evaluators.ts";
import { renderProviderOriginalMessages } from "../../runtime/provider-originals.ts";
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
const originalText = "  Keep this exact original.\nIncluding  whitespace.\n";
const originalMessages = {
  header: "Authorized original",
  sources: [
    {
      id: "recalled1",
      prefix: "User: ",
      originalText,
      memoryId: "original-memory",
      agentId: "00000000-0000-4000-8000-000000000003",
      roomId: message.roomId,
      entityId: message.entityId,
      createdAt: 1,
    },
  ],
};
const providerText = renderProviderOriginalMessages(originalMessages);
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

function fixture(responses: unknown[], discoverable = true) {
  const state: State = {
    values: {},
    text: "",
    data: {
      providers: {
        CHOICE: {
          text: providerText,
          ...(discoverable
            ? { discoveryText: "context_discovery: CHOICE" }
            : {}),
          data: { originalMessages },
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

const malformed = () => ({
  ...decision,
  toolCalls: [
    {
      name: "HANDLE_RESPONSE",
      arguments: {
        ...decision.toolCalls[0].arguments,
        replyText: [{ kind: "source", value: originalText.trim() }],
        facts: ["INVALID_DRAFT_MUST_NOT_DISPATCH"],
      },
    },
  ],
});
const run = (f: ReturnType<typeof fixture>) =>
  runV5MessageRuntimeStage1({
    runtime: f.runtime,
    state: f.state,
    message,
    responseId: "00000000-0000-4000-8000-000000000005" as UUID,
    stage1DecisionOnly: true,
  });
const correction = "Your previous response used an invalid source quote.";

describe("source repair through the production Stage 1 pipeline", () => {
  it("repairs a quote after fresh discovery without dispatching its invalid fields", async () => {
    const f = fixture([read(["CHOICE"]), malformed(), decision]);
    expect((await run(f)).kind).toBe("decision");
    expect(f.useModel).toHaveBeenCalledTimes(3);
    expect(f.composeState).toHaveBeenCalledTimes(1);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.dispatch.mock.calls)).not.toContain(
      "INVALID_DRAFT_MUST_NOT_DISPATCH",
    );
    expect(JSON.stringify(f.useModel.mock.calls[0])).not.toContain(
      originalText.trim(),
    );
    expect(JSON.stringify(f.useModel.mock.calls[1])).toContain(
      JSON.stringify(originalText).slice(1, -1),
    );
    expect(JSON.stringify(f.useModel.mock.calls[2])).toContain(correction);
    expect(f.action).not.toHaveBeenCalled();
  });

  it("fails closed after one repair when the newly discovered quote remains invalid", async () => {
    const f = fixture([read(["CHOICE"]), malformed(), malformed(), decision]);
    await expect(run(f)).rejects.toMatchObject({
      code: "STAGE1_INVALID_SOURCE_REPLY",
    });
    expect(f.useModel).toHaveBeenCalledTimes(3);
    expect(f.composeState).toHaveBeenCalledTimes(1);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.action).not.toHaveBeenCalled();
  });

  it("honors cancellation between receiving the invalid quote and generating its repair", async () => {
    const controller = new AbortController();
    const failure = new DOMException("cancelled", "AbortError");
    const f = fixture([]);
    let calls = 0;
    f.useModel.mockImplementation(async () => {
      if (++calls === 1) return read(["CHOICE"]);
      controller.abort(failure);
      return malformed();
    });
    await expect(
      runWithStreamingContext(
        { messageId: "source-cancel", abortSignal: controller.signal },
        () => run(f),
      ),
    ).rejects.toBe(failure);
    expect(f.useModel).toHaveBeenCalledTimes(2);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.action).not.toHaveBeenCalled();
  });

  it("preserves the prior response-contract correction when its retry needs source repair", async () => {
    const empty = {
      ...decision,
      toolCalls: [
        {
          name: "HANDLE_RESPONSE",
          arguments: {
            ...decision.toolCalls[0].arguments,
            contexts: ["simple"],
            intents: [],
            candidateActionNames: [],
            replyText: "",
            replyEffectStatus: "none",
          },
        },
      ],
    };
    const f = fixture([empty, malformed(), decision], false);
    expect((await run(f)).kind).toBe("decision");
    expect(f.useModel).toHaveBeenCalledTimes(3);
    const repaired = JSON.stringify(f.useModel.mock.calls[2]);
    expect(repaired).toContain("response_contract_repair:");
    expect(repaired).toContain(correction);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.action).not.toHaveBeenCalled();
  });
});
