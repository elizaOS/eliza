import { ModelType } from "@elizaos/core";

type JsonRecord = Record<string, unknown>;

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

function matchesScenarioInput(expected: string) {
  return (value: string) =>
    value === expected ||
    value.endsWith(`message:user:\n${expected}`) ||
    value.includes(`\nmessage:user:\n${expected}`);
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
