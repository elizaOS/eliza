/**
 * Keyless per-plugin e2e for `@elizaos/plugin-benchmarks` (issue #8801).
 *
 * The benchmarks plugin's agent-action surface includes `OSWORLD`, a
 * bench-side handler whose validate() is unconditional and whose handler
 * returns a deterministic success envelope (the OSWorld environment executes
 * the real action out-of-band). This drives it end-to-end through the
 * deterministic LLM proxy with zero credentials and no benchmark execution.
 */
import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";

const TASK_INPUT = "Run the OSWorld benchmark step: save the open document.";
const OSWORLD = "OSWORLD";

type RuntimeWithScenarioLlmFixtures = AgentRuntime & {
  scenarioLlmFixtures?: {
    register: (...fixtures: Array<Record<string, unknown>>) => void;
  };
};

function osworldRouteFixtures(): Array<Record<string, unknown>> {
  const inputMatches = (value: string) => value.includes("OSWorld");
  return [
    {
      name: "route-osworld-stage1",
      match: {
        modelType: ModelType.RESPONSE_HANDLER,
        input: inputMatches,
        toolName: "HANDLE_RESPONSE",
      },
      response: {
        contexts: ["general"],
        intents: ["benchmark"],
        replyText: "",
        threadOps: [],
        candidateActionNames: [OSWORLD],
      },
      times: 1,
    },
    {
      name: "route-osworld-planner",
      match: {
        modelType: ModelType.ACTION_PLANNER,
        input: inputMatches,
        toolName: OSWORLD,
      },
      response: {
        text: "",
        thought: "Dispatch the OSWorld bench-side action.",
        messageToUser: "",
        completed: true,
        finishReason: "tool-calls",
        toolCalls: [
          {
            id: "call-osworld",
            name: OSWORLD,
            type: "function",
            arguments: { action: "screenshot" },
          },
        ],
      },
      times: 1,
    },
  ];
}

export default scenario({
  lane: "pr-deterministic",
  id: "benchmarks.osworld-action",
  title: "Benchmarks: OSWORLD bench-side action succeeds",
  domain: "benchmarks",
  tags: ["smoke", "benchmarks", "osworld"],
  description:
    "Drives the OSWORLD bench-side action and verifies it is selected and succeeds via the deterministic LLM proxy — keyless, no benchmark execution.",

  requires: {
    plugins: ["@elizaos/plugin-benchmarks"],
  },
  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "register-osworld-fixtures",
      apply: async (ctx) => {
        const runtime = ctx.runtime as RuntimeWithScenarioLlmFixtures;
        runtime.scenarioLlmFixtures?.register(...osworldRouteFixtures());
        return undefined;
      },
    },
  ],

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Benchmarks: OSWorld",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "osworld-step",
      text: TASK_INPUT,
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find(
          (action) => action.actionName === OSWORLD,
        );
        if (!call) {
          return `Expected ${OSWORLD} but got: ${turn.actionsCalled
            .map((action) => action.actionName)
            .join(", ")}`;
        }
        if (!call.result?.success) {
          return `${OSWORLD} did not succeed: ${
            call.error?.message ?? "unknown error"
          }`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: OSWORLD,
      status: "success",
      minCount: 1,
    },
  ],
});
