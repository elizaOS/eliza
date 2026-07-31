/**
 * The public message pipeline must deliver every LIST_CLOUD_APPS outcome once,
 * whether an action callback transport exists or the planner owns delivery.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
  BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  normalizeVisibleTextForDuplicateCheck,
  ResponseHandlerFieldRegistry,
  runV5MessageRuntimeStage1,
  type State,
  type UUID,
  wrapSingleTurnVisibleCallback,
} from "@elizaos/core";
import {
  FakeElizaCloudClient,
  keyedRuntime,
  makeApp,
  resetSdk,
  setListApps,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));

const { listCloudAppsAction } = await import(
  "../src/actions/list-cloud-apps.ts"
);

const AGENT_ID = "00000000-0000-0000-0000-000000000003" as UUID;
const MESSAGE_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const ENTITY_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000004" as UUID;
const RESPONSE_ID = "00000000-0000-0000-0000-000000000005" as UUID;

function message(): Memory {
  return {
    id: MESSAGE_ID,
    entityId: ENTITY_ID,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    content: { text: "list my cloud apps", source: "test" },
    createdAt: 1,
  };
}

function state(): State {
  return {
    values: { availableContexts: "general, apps" },
    data: {},
    text: "Cloud apps are available.",
  };
}

function stageOneResponse() {
  return {
    text: "",
    toolCalls: [
      {
        id: "handle-response-1",
        name: "HANDLE_RESPONSE",
        arguments: {
          shouldRespond: "RESPOND",
          thought: "The user requested cloud inventory.",
          contexts: ["general"],
          intents: [],
          candidateActionNames: ["LIST_CLOUD_APPS"],
          replyText: "",
          facts: [],
          relationships: [],
          addressedTo: [],
        },
      },
    ],
  };
}

function makeRuntime(): {
  runtime: IAgentRuntime;
  modelTypes: string[];
} {
  const base = keyedRuntime();
  const responses = [
    stageOneResponse(),
    {
      text: "",
      toolCalls: [
        {
          id: "list-cloud-apps-1",
          name: "LIST_CLOUD_APPS",
          arguments: {},
        },
      ],
    },
  ];
  const modelTypes: string[] = [];
  const responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
  for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
    responseHandlerFieldRegistry.register(evaluator);
  }

  const runtime = {
    ...base,
    agentId: AGENT_ID,
    character: {
      name: "Cloud Test Agent",
      system: "Answer with verified cloud inventory.",
      bio: "I manage cloud apps.",
    },
    actions: [listCloudAppsAction],
    providers: [],
    composeState: async () => state(),
    runActionsByMode: async () => undefined,
    emitEvent: async () => undefined,
    useModel: async (modelType: unknown) => {
      modelTypes.push(String(modelType));
      const next = responses.shift();
      if (!next) {
        throw new Error(`Unexpected model call for ${String(modelType)}`);
      }
      return next;
    },
    getSetting: (key: string) =>
      key === "ACTION_CALLBACK_VOICE_REWRITE" ? "false" : base.getSetting(key),
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      trace: () => undefined,
    },
    responseHandlerFieldRegistry,
    responseHandlerFieldEvaluators: [
      ...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
    ],
    responseHandlerEvaluators: [],
  } as unknown as IAgentRuntime;

  return { runtime, modelTypes };
}

async function runTurn(withCallback: boolean): Promise<{
  callbackTexts: string[];
  finalText: string | undefined;
  modelTypes: string[];
}> {
  const { runtime, modelTypes } = makeRuntime();
  const currentMessage = message();
  const callbackTexts: string[] = [];
  const deliveredVisibleTexts = new Set<string>();
  const callback: HandlerCallback = async (content: Content) => {
    if (content.text) callbackTexts.push(content.text);
    return [];
  };
  const wrappedCallback = withCallback
    ? wrapSingleTurnVisibleCallback(runtime, currentMessage, callback, (text) =>
        deliveredVisibleTexts.add(normalizeVisibleTextForDuplicateCheck(text)),
      )
    : undefined;

  const result = await runV5MessageRuntimeStage1({
    runtime,
    message: currentMessage,
    state: state(),
    responseId: RESPONSE_ID,
    ...(wrappedCallback ? { callback: wrappedCallback } : {}),
    deliveredVisibleTexts,
  });

  return {
    callbackTexts,
    finalText:
      result.kind === "planned_reply"
        ? result.result.responseContent?.text
        : undefined,
    modelTypes,
  };
}

describe("LIST_CLOUD_APPS public message delivery", () => {
  beforeEach(() => {
    resetSdk();
  });

  for (const scenario of [
    {
      name: "non-empty inventory",
      arrange: () =>
        setListApps(() =>
          Promise.resolve({
            success: true,
            apps: [makeApp({ name: "Cloud Notes", slug: "cloud-notes" })],
          }),
        ),
      expected: "Cloud Notes",
    },
    {
      name: "empty inventory",
      arrange: () =>
        setListApps(() => Promise.resolve({ success: true, apps: [] })),
      expected: "haven't created any apps",
    },
    {
      name: "Cloud API error",
      arrange: () =>
        setListApps(() => Promise.reject(new Error("provider unavailable"))),
      expected: "couldn't fetch",
    },
  ]) {
    it(`delivers ${scenario.name} once through a callback transport`, async () => {
      scenario.arrange();

      const result = await runTurn(true);

      expect(result.callbackTexts).toHaveLength(1);
      expect(result.callbackTexts[0]).toContain(scenario.expected);
      expect(result.finalText).toBeUndefined();
      expect(result.modelTypes).toEqual([
        String(ModelType.RESPONSE_HANDLER),
        String(ModelType.ACTION_PLANNER),
      ]);
    });

    it(`delivers ${scenario.name} once without a callback transport`, async () => {
      scenario.arrange();

      const result = await runTurn(false);

      expect(result.callbackTexts).toEqual([]);
      expect(result.finalText).toContain(scenario.expected);
      expect(result.modelTypes).toEqual([
        String(ModelType.RESPONSE_HANDLER),
        String(ModelType.ACTION_PLANNER),
      ]);
    });
  }
});
