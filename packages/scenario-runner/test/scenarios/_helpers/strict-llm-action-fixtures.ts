import { ModelType } from "@elizaos/core";

type JsonRecord = Record<string, unknown>;
const MESSAGE_USER_MARKER = "message:user:\n";
const EXTERNAL_CONTENT_START = "<<<EXTERNAL_UNTRUSTED_CONTENT>>>";
const EXTERNAL_CONTENT_END = "<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>";
const EXTERNAL_CONTENT_SEPARATOR = "\n---\n";
const MESSAGE_USER_SUFFIX_BOUNDARY =
  /\n\n(?:event:|provider:|current_turn_boundary:|The Stage 1 router)/;

export type RuntimeWithScenarioLlmFixtures = {
  scenarioLlmFixtures?: {
    register: (...fixtures: Array<Record<string, unknown>>) => void;
  };
};

export type StrictActionRouteFixture = {
  actionName: string;
  args: JsonRecord;
  contextIds?: readonly string[];
  input: string;
  messageToUser?: string;
};

function finalMessageUserText(value: string): string {
  const markerIndex = value.lastIndexOf(MESSAGE_USER_MARKER);
  const messageText =
    markerIndex === -1
      ? value
      : value.slice(markerIndex + MESSAGE_USER_MARKER.length);
  const envelopeStart = messageText.lastIndexOf(EXTERNAL_CONTENT_START);
  const envelopeEnd = messageText.lastIndexOf(EXTERNAL_CONTENT_END);
  if (envelopeStart === -1 || envelopeEnd <= envelopeStart) {
    return messageText.split(MESSAGE_USER_SUFFIX_BOUNDARY, 1)[0]?.trim() ?? "";
  }
  const envelopeText = messageText.slice(
    envelopeStart + EXTERNAL_CONTENT_START.length,
    envelopeEnd,
  );
  const separatorIndex = envelopeText.indexOf(EXTERNAL_CONTENT_SEPARATOR);
  return (
    separatorIndex === -1
      ? envelopeText
      : envelopeText.slice(separatorIndex + EXTERNAL_CONTENT_SEPARATOR.length)
  ).trim();
}

function matchesScenarioInput(expected: string) {
  return (value: string) => finalMessageUserText(value) === expected;
}

export function strictActionRouteFixtures(
  spec: StrictActionRouteFixture,
): Array<Record<string, unknown>> {
  const actionSlug = spec.actionName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const replyText = spec.messageToUser ?? "On it.";

  return [
    {
      name: `route-${actionSlug}-stage1-${spec.input}`,
      match: {
        modelType: ModelType.RESPONSE_HANDLER,
        input: matchesScenarioInput(spec.input),
        toolName: "HANDLE_RESPONSE",
      },
      response: {
        contexts: spec.contextIds ?? ["general"],
        intents: [spec.input.toLowerCase()],
        replyText,
        threadOps: [],
        candidateActionNames: [spec.actionName],
      },
      times: 1,
    },
    {
      name: `route-${actionSlug}-planner-${spec.input}`,
      match: {
        modelType: ModelType.ACTION_PLANNER,
        input: matchesScenarioInput(spec.input),
        toolName: spec.actionName,
      },
      response: {
        text: "",
        thought: `Call ${spec.actionName} for ${spec.input}.`,
        messageToUser: replyText,
        completed: true,
        finishReason: "tool-calls",
        toolCalls: [
          {
            id: `call-${actionSlug}`,
            name: spec.actionName,
            type: "function",
            arguments: spec.args,
          },
        ],
      },
      times: 1,
    },
  ];
}

export function registerStrictActionRouteFixtures(
  runtime: RuntimeWithScenarioLlmFixtures,
  specs: readonly StrictActionRouteFixture[],
): void {
  runtime.scenarioLlmFixtures?.register(
    ...specs.flatMap((spec) => strictActionRouteFixtures(spec)),
  );
}
