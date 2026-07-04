/**
 * Keyless coverage for the media-generation action surface. Runs on the
 * pr-deterministic lane under the LLM proxy.
 */
import { ModelType, type Plugin } from "@elizaos/core";
import type {
  CapturedAction,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { generateMediaAction } from "../../../../plugins/plugin-local-inference/src/actions/generate-media.ts";
import {
  type RuntimeWithScenarioLlmFixtures,
  registerStrictActionRouteFixtures,
} from "./_helpers/strict-llm-action-fixtures";

const transparentPngDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lbJY7wAAAABJRU5ErkJggg==";
const wavBytes = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66,
  0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x40, 0x1f,
  0x00, 0x00, 0x80, 0x3e, 0x00, 0x00, 0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74,
  0x61, 0x00, 0x00, 0x00, 0x00,
]);

const modelCalls: Array<{ modelType: string; payload: unknown }> = [];

const imageGenerateMediaParameters = {
  mediaType: "image",
  prompt: "scenario sunset",
};
const audioGenerateMediaParameters = {
  mediaType: "audio",
  prompt: "scenario audio",
};

const strictMediaRoutes = [
  {
    actionName: "GENERATE_MEDIA",
    args: imageGenerateMediaParameters,
    contextIds: ["media"],
    input: "Draw scenario sunset",
    messageToUser: "Here's the image you asked for.",
  },
  {
    actionName: "GENERATE_MEDIA",
    args: audioGenerateMediaParameters,
    contextIds: ["media"],
    input: "Say scenario audio",
    messageToUser: "Here's the audio you asked for.",
  },
];

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function actionParameters(action: CapturedAction): JsonRecord {
  const params = isRecord(action.parameters) ? action.parameters : {};
  return isRecord(params.parameters) ? params.parameters : params;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function expectEqual(
  actual: unknown,
  expected: unknown,
  label: string,
): string | undefined {
  const actualJson = stableStringify(actual);
  const expectedJson = stableStringify(expected);
  return actualJson === expectedJson
    ? undefined
    : `expected ${label}=${expectedJson}, saw ${actualJson}`;
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".").filter(Boolean)) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
      continue;
    }
    current = isRecord(current) ? current[segment] : undefined;
  }
  return current;
}

function firstAction(
  execution: ScenarioTurnExecution,
  actionName: string,
): CapturedAction | string {
  const action = execution.actionsCalled.find(
    (candidate) => candidate.actionName === actionName,
  );
  return (
    action ??
    `expected ${actionName} action, saw ${execution.actionsCalled.map((candidate) => candidate.actionName).join(", ") || "none"}`
  );
}

function expectAction(
  execution: ScenarioTurnExecution,
  expected: {
    actionName: string;
    parameters: JsonRecord;
    resultFields: JsonRecord;
  },
): string | undefined {
  const action = firstAction(execution, expected.actionName);
  if (typeof action === "string") return action;
  const actualParameters = actionParameters(action);
  const directParametersFailure = expectEqual(
    actualParameters,
    expected.parameters,
    `${expected.actionName} handler options`,
  );
  const wrappedParametersFailure = expectEqual(
    actualParameters,
    { parameters: expected.parameters },
    `${expected.actionName} handler options`,
  );
  const parametersFailure =
    directParametersFailure && wrappedParametersFailure
      ? directParametersFailure
      : undefined;
  return (
    parametersFailure ??
    (action.result?.success === true
      ? undefined
      : `expected ${expected.actionName} ActionResult.success=true, saw ${stableStringify(action.result)}`) ??
    (() => {
      for (const [path, expectedValue] of Object.entries(
        expected.resultFields,
      )) {
        const actual = readPath(action.result, path);
        const failure = expectEqual(
          actual,
          expectedValue,
          `${expected.actionName} result.${path}`,
        );
        if (failure) return failure;
      }
      return undefined;
    })()
  );
}

const deterministicMediaPlugin: Plugin = {
  name: "scenario-deterministic-media-actions",
  description:
    "Scenario-only media action registration with deterministic model backends.",
  priority: 1_000,
  actions: [generateMediaAction],
  models: {
    [ModelType.IMAGE]: async (_runtime, payload) => {
      modelCalls.push({ modelType: ModelType.IMAGE, payload });
      return [{ url: transparentPngDataUrl }];
    },
    [ModelType.TEXT_TO_SPEECH]: async (_runtime, payload) => {
      modelCalls.push({ modelType: ModelType.TEXT_TO_SPEECH, payload });
      return wavBytes;
    },
  },
};

async function finalLedgerCheck(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const names = (ctx.actionsCalled ?? []).map((call) => call.actionName);
  const orderFailure = expectEqual(
    names,
    ["GENERATE_MEDIA", "GENERATE_MEDIA"],
    "media action order",
  );
  if (orderFailure) return orderFailure;

  const failed = (ctx.actionsCalled ?? []).filter(
    (call) => call.result?.success !== true,
  );
  if (failed.length > 0) {
    return `expected every media action to succeed, saw ${stableStringify(failed)}`;
  }

  const modelFailure = expectEqual(
    modelCalls.map((call) => call.modelType),
    [ModelType.IMAGE, ModelType.TEXT_TO_SPEECH],
    "model call order",
  );
  if (modelFailure) return modelFailure;

  const imagePayload = modelCalls[0]?.payload;
  if (readPath(imagePayload, "prompt") !== "scenario sunset") {
    return `expected image prompt to be stripped to scenario sunset, saw ${stableStringify(imagePayload)}`;
  }
  const audioPayload = modelCalls[1]?.payload;
  if (readPath(audioPayload, "text") !== "scenario audio") {
    return `expected TTS text to be stripped to scenario audio, saw ${stableStringify(audioPayload)}`;
  }
  return undefined;
}

export default scenario({
  id: "deterministic-media-actions",
  lane: "pr-deterministic",
  title: "Deterministic media generation actions",
  domain: "scenario-runner",
  tags: ["pr", "deterministic", "zero-cost", "media"],
  isolation: "shared-runtime",
  requires: {
    plugins: ["scenario-deterministic-media-actions"],
  },
  seed: [
    {
      type: "custom",
      name: "register deterministic media model handlers",
      apply: async (ctx) => {
        modelCalls.length = 0;

        const runtime = ctx.runtime as
          | (RuntimeWithScenarioLlmFixtures & {
              plugins?: Array<{ name?: string }>;
              registerPlugin?: (plugin: Plugin) => Promise<void>;
              unregisterAction?: (name: string) => boolean;
            })
          | undefined;
        if (!runtime?.registerPlugin) {
          return "runtime.registerPlugin unavailable";
        }
        if (
          !runtime.plugins?.some(
            (plugin) => plugin.name === deterministicMediaPlugin.name,
          )
        ) {
          runtime.unregisterAction?.("GENERATE_MEDIA");
          await runtime.registerPlugin(deterministicMediaPlugin);
        }
        registerStrictActionRouteFixtures(runtime, strictMediaRoutes);
        return undefined;
      },
    },
  ],
  rooms: [
    {
      id: "main",
      source: "client_chat",
      title: "Deterministic Media",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "generate deterministic image attachment",
      text: "Draw scenario sunset",
      responseIncludesAny: [
        "Here's the image you asked for.",
        "the image you asked for.",
      ],
      assertTurn: (execution) =>
        expectAction(execution, {
          actionName: "GENERATE_MEDIA",
          parameters: imageGenerateMediaParameters,
          resultFields: {
            "data.source": "generate-media",
            "data.computerUseAction": "GENERATE_MEDIA_IMAGE",
            "data.detectedKind": "image",
            "data.detectedSource": "keyword",
            "data.prompt": "scenario sunset",
            "data.mime": "image/png",
            "values.mediaKind": "image",
          },
        }),
    },
    {
      kind: "message",
      name: "generate deterministic audio attachment",
      text: "Say scenario audio",
      responseIncludesAny: [
        "Here's the audio you asked for.",
        "the audio you asked for.",
      ],
      assertTurn: (execution) =>
        expectAction(execution, {
          actionName: "GENERATE_MEDIA",
          parameters: audioGenerateMediaParameters,
          resultFields: {
            "data.source": "generate-media",
            "data.computerUseAction": "GENERATE_MEDIA_AUDIO",
            "data.detectedKind": "audio",
            "data.detectedSource": "keyword",
            "data.prompt": "scenario audio",
            "data.mime": "audio/wav",
            "values.mediaKind": "audio",
          },
        }),
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "GENERATE_MEDIA",
      status: "success",
      minCount: 2,
    },
    {
      type: "selectedActionArguments",
      actionName: ["GENERATE_MEDIA"],
      includesAll: [/scenario sunset/],
    },
    {
      type: "custom",
      name: "media model handlers were called exactly",
      predicate: finalLedgerCheck,
    },
  ],
});
