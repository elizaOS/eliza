/**
 * Ported from `eliza/packages/app-core/test/convo-testing/scenarios/echo-self-test.convo.test.ts`.
 *
 * Framework self-test: sends a message and verifies the `ECHO_TEST` action is
 * captured by the runner's action interceptor. Preserves the original
 * semantics exactly — same user utterance, same expected action, same
 * per-turn predicate, plus a matching `actionCalled` final check.
 *
 * Because the new scenario schema does not accept an inline `plugins` array,
 * the trivial `ECHO_TEST` plugin lives in `./_fixtures/echo-test-plugin.ts`
 * and is registered via a `custom` seed step.
 */

import type { AgentRuntime, Plugin } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";
import { echoTestPlugin } from "./_fixtures/echo-test-plugin.ts";

const ECHO_INPUT = "Please echo this message back to me: hello world";

type RuntimeWithScenarioLlmFixtures = AgentRuntime & {
  scenarioLlmFixtures?: {
    register: (...fixtures: Array<Record<string, unknown>>) => void;
  };
};

function asRuntime(value: unknown): RuntimeWithScenarioLlmFixtures {
  if (!value || typeof value !== "object" || !("registerPlugin" in value)) {
    throw new Error(
      "echo-self-test seed: runtime did not expose registerPlugin",
    );
  }
  return value as RuntimeWithScenarioLlmFixtures;
}

/**
 * Under the deterministic LLM proxy (`SCENARIO_USE_LLM_PROXY=1`) the proxy has
 * no model intelligence to pick `ECHO_TEST` over a plain reply, so we register
 * the two routing fixtures that force the selection: the stage-1 response
 * handler nominates `ECHO_TEST` as the only candidate, and the action planner
 * emits the matching tool call. This is what makes the scenario genuinely
 * keyless-deterministic (lane `pr-deterministic`).
 */
function echoRouteFixtures(): Array<Record<string, unknown>> {
  const inputMatches = (value: string) => value.includes(ECHO_INPUT);
  return [
    {
      name: "route-echo-stage1",
      match: {
        modelType: ModelType.RESPONSE_HANDLER,
        input: inputMatches,
        toolName: "HANDLE_RESPONSE",
      },
      response: {
        contexts: ["general"],
        intents: ["echo"],
        replyText: "On it.",
        threadOps: [],
        candidateActionNames: ["ECHO_TEST"],
      },
      times: 1,
    },
    {
      name: "route-echo-planner",
      match: {
        modelType: ModelType.ACTION_PLANNER,
        input: inputMatches,
        toolName: "ECHO_TEST",
      },
      response: {
        text: "",
        thought: "Call ECHO_TEST to echo the user's message.",
        messageToUser: "On it.",
        completed: true,
        finishReason: "tool-calls",
        toolCalls: [
          {
            id: "call-echo-test",
            name: "ECHO_TEST",
            type: "function",
            arguments: {},
          },
        ],
      },
      times: 1,
    },
  ];
}

export default scenario({
  id: "convo.echo-self-test",
  title: "Convo framework self-test: ECHO_TEST action is captured",
  domain: "convo",
  // Keyless-deterministic: the trivial ECHO_TEST plugin runs in-memory and the
  // routing fixtures registered below force the action selection under the
  // deterministic LLM proxy. No external service, no secret. Verified passing
  // under SCENARIO_USE_LLM_PROXY=1.
  lane: "pr-deterministic",
  tags: ["smoke", "convo", "self-test"],
  description:
    "Registers a trivial ECHO_TEST plugin and verifies the scripted runner captures the action call with success=true.",

  requires: {
    plugins: ["echo-test"],
  },
  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "register-echo-test-plugin",
      apply: async (ctx) => {
        const runtime = asRuntime(ctx.runtime);
        await runtime.registerPlugin(echoTestPlugin satisfies Plugin);
        runtime.scenarioLlmFixtures?.register(...echoRouteFixtures());
      },
    },
  ],

  turns: [
    {
      kind: "message",
      name: "echo-hello-world",
      text: ECHO_INPUT,
      expectedActions: ["ECHO_TEST"],
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        if (turn.actionsCalled.length === 0) {
          return "Expected at least one action to be called";
        }
        const echo = turn.actionsCalled.find(
          (a) => a.actionName === "ECHO_TEST",
        );
        if (!echo) {
          return `Expected ECHO_TEST action but got: ${turn.actionsCalled
            .map((a) => a.actionName)
            .join(", ")}`;
        }
        if (!echo.result?.success) {
          return `ECHO_TEST action did not succeed: ${
            echo.error?.message ?? "unknown error"
          }`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: "ECHO_TEST",
      status: "success",
      minCount: 1,
    },
    {
      // Effect proof (#11381): the handler really received the inbound
      // message content through the pipeline — its result text must be the
      // exact echo of the user's utterance, not merely success=true.
      type: "custom",
      name: "echo-payload-roundtrip-effect",
      predicate: (ctx) => {
        const call = ctx.actionsCalled.find(
          (action) =>
            action.actionName === "ECHO_TEST" &&
            action.result?.success === true,
        );
        if (!call) {
          return "no successful ECHO_TEST call captured";
        }
        const expected = `Echo: ${ECHO_INPUT}`;
        if (call.result?.text !== expected) {
          return `expected the echoed message ${JSON.stringify(expected)} in result.text, saw ${JSON.stringify(call.result?.text ?? null)}`;
        }
      },
    },
  ],
});
