/**
 * Context hygiene across a simple and a multi-step turn: Stage 1 answers a
 * question directly, then routes a greeting to discovery; the planner loads
 * GREET_USER through DISCOVER_ACTIONS, runs it, and the evaluators settle the
 * turn. Model inputs are captured so final checks can prove each stage receives
 * only instructions that apply to its surface (#31017) while both turns still
 * complete.
 */

import {
  type AgentRuntime,
  type GenerateTextParams,
  ModelType,
  type Plugin,
} from "@elizaos/core";
import { scenario } from "@elizaos/testing";
import {
  type DeterministicModelFixture,
  strictActionRouteFixtures,
  strictTerminalReplyFixture,
  transientTurnEvaluationSeed,
} from "@elizaos/testing/models";
import { greetTestPlugin } from "./_fixtures/greet-test-plugin.ts";

const INPUT = "Hello!";
const SIMPLE_INPUT = "What is the capital of France?";
const SIMPLE_REPLY = "The capital of France is Paris.";

type CapturedCall = { modelType: string; params: GenerateTextParams };
const captured: CapturedCall[] = [];

type RuntimeWithScenarioModelFixtures = AgentRuntime & {
  scenarioModelFixtures?: {
    register: (...fixtures: DeterministicModelFixture[]) => void;
  };
};

function asRuntime(value: unknown): RuntimeWithScenarioModelFixtures {
  if (!value || typeof value !== "object" || !("registerPlugin" in value)) {
    throw new Error(
      "context-hygiene seed: runtime did not expose registerPlugin",
    );
  }
  return value as RuntimeWithScenarioModelFixtures;
}

/** Records the complete model input each fixture answers. */
function recording(
  fixture: DeterministicModelFixture,
): DeterministicModelFixture {
  const { response } = fixture;
  return {
    ...fixture,
    response: undefined,
    resolve: (call) => {
      captured.push({ modelType: call.modelType, params: call.params });
      return typeof response === "function" ? response(call) : response;
    },
  };
}

function modelText(call: CapturedCall): string {
  const system =
    typeof call.params.system === "string" ? call.params.system : "";
  const messages = (call.params.messages ?? [])
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content),
    )
    .join("\n");
  return `${system}\n${messages}`;
}

export default scenario({
  lane: "pr-deterministic",
  modelFixtures: { mode: "fixtures", fixtures: [] },
  id: "convo.context-hygiene",
  title:
    "Context hygiene: multi-step discovery turn carries only applicable instructions",
  domain: "convo",
  tags: ["smoke", "convo", "context"],
  description:
    "Routes a greeting through DISCOVER_ACTIONS and GREET_USER, then checks the planner and evaluator inputs omit instructions for tools and context routes that are not available.",
  requires: { fixturePlugins: ["greet-test"] },
  isolation: "per-scenario",
  seed: [
    {
      type: "custom",
      name: "register-greet-test-plugin",
      apply: async (ctx) => {
        const runtime = asRuntime(ctx.runtime);
        captured.length = 0;
        await runtime.registerPlugin(greetTestPlugin satisfies Plugin);
        runtime.scenarioModelFixtures?.register(
          recording(
            strictTerminalReplyFixture({
              input: SIMPLE_INPUT,
              text: SIMPLE_REPLY,
              contextIds: ["simple"],
            }),
          ),
          ...strictActionRouteFixtures({
            actionName: "GREET_USER",
            discoverBeforeExecution: true,
            args: {},
            input: INPUT,
            messageToUser: "Hello there.",
          }).map(recording),
        );
      },
    },
    transientTurnEvaluationSeed(
      [
        {
          input: INPUT,
          action: "GREET_USER",
          completed: true,
          reason: "GREET_USER greeted the user.",
        },
      ],
      "A greeting states no durable personal fact.",
    ),
  ],
  turns: [
    {
      kind: "message",
      name: "simple-reply",
      text: SIMPLE_INPUT,
      timeoutMs: 120_000,
      assertTurn: (turn) =>
        turn.responseText?.includes("Paris")
          ? undefined
          : `expected the terminal reply, saw ${JSON.stringify(turn.responseText)}`,
    },
    {
      kind: "message",
      name: "greet-after-discovery",
      text: INPUT,
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const greet = turn.actionsCalled.find(
          (action) => action.actionName === "GREET_USER",
        );
        if (!greet?.result?.success) {
          return `GREET_USER did not succeed: ${JSON.stringify(turn.actionsCalled.map((action) => action.actionName))}`;
        }
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "GREET_USER",
      status: "success",
      minCount: 1,
    },
    {
      type: "custom",
      name: "planner-omits-unexposed-tool-rules",
      predicate: () => {
        const planners = captured.filter(
          (call) => call.modelType === ModelType.ACTION_PLANNER,
        );
        if (planners.length !== 2) {
          return `expected discovery and execution planner calls, saw ${planners.length}`;
        }
        for (const call of planners) {
          const exposed = new Set(
            (call.params.tools ?? []).map((tool) => tool.name),
          );
          const text = modelText(call);
          for (const [tool, rule] of [
            ["SHELL", "SHELL is for filesystem/process work"],
            ["TASKS_SPAWN_AGENT", "TASKS_SPAWN_AGENT delegates coding"],
          ] as const) {
            if (!exposed.has(tool) && text.includes(rule)) {
              return `planner carried the ${tool} rule without exposing ${tool}`;
            }
          }
          if (!text.includes("candidateActions are retrieval hints")) {
            return "planner lost the shared discovery rule";
          }
        }
      },
    },
    {
      type: "custom",
      name: "evaluator-advertises-only-available-routes",
      predicate: () => {
        const evaluator = captured.find(
          (call) =>
            call.modelType === ModelType.RESPONSE_HANDLER &&
            !(call.params.tools ?? []).length,
        );
        if (!evaluator) return "planner-loop evaluator call was not captured";
        const text = modelText(evaluator);
        // The reusable protocol and response schema keep the full decision
        // superset for a stable prefix; eligibility lives in the per-call
        // decision state, and the runtime rejects unavailable restoration.
        const decisionState = text.slice(
          text.lastIndexOf("# Current decision state"),
        );
        if (!decisionState.startsWith("# Current decision state")) {
          return "evaluator omitted its current decision state";
        }
        if (!decisionState.includes("Available restoration routes: none")) {
          return "evaluator advertised context restoration with nothing deferred";
        }
        if (
          /Choose (?:one restoration decision|RESTORE_)/.test(decisionState)
        ) {
          return "evaluator carried restoration guidance with nothing deferred";
        }
        const decision = (
          evaluator.params.responseSchema as {
            properties?: { decision?: { enum?: string[] } };
          }
        )?.properties?.decision?.enum;
        if (!decision?.includes("FINISH")) {
          return `evaluator decision enum ${JSON.stringify(decision)} lost FINISH`;
        }
        if (
          !text.includes("success=true needs completed tool result evidence")
        ) {
          return "evaluator lost its completion evidence rule";
        }
      },
    },
  ],
});
