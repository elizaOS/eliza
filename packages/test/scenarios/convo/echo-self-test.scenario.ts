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
import { scenario } from "@elizaos/scenario-runner/schema";
import { echoTestPlugin } from "./_fixtures/echo-test-plugin.ts";

const ECHO_INPUT = "Please echo this message back to me: hello world";

type RuntimeWithPluginRegistration = AgentRuntime;

function asRuntime(value: unknown): RuntimeWithPluginRegistration {
  if (!value || typeof value !== "object" || !("registerPlugin" in value)) {
    throw new Error(
      "echo-self-test seed: runtime did not expose registerPlugin",
    );
  }
  return value as RuntimeWithPluginRegistration;
}

export default scenario({
  id: "convo.echo-self-test",
  title: "Convo framework self-test: ECHO_TEST action is captured",
  domain: "convo",
  // Keyless-deterministic: the trivial ECHO_TEST plugin runs in-memory and the
  // routing fixtures registered below force the action selection under the
  // deterministic model provider. No external service, no secret. Verified passing
  // under SCENARIO_USE_DETERMINISTIC_MODEL=1.
  lane: "pr-deterministic",
  modelFixtures: {
    mode: "fixtures",
    fixtures: [
      {
        name: "route-echo-stage1",
        match: {
          modelType: "RESPONSE_HANDLER",
          input: { includes: ECHO_INPUT },
          toolNames: ["HANDLE_RESPONSE"],
        },
        cardinality: 1,
        response: {
          json: {
            contexts: ["general"],
            intents: ["echo"],
            replyText: "On it.",
            threadOps: [],
            candidateActionNames: ["ECHO_TEST"],
          },
        },
      },
      {
        name: "route-echo-planner",
        match: {
          modelType: "ACTION_PLANNER",
          input: { includes: ECHO_INPUT },
          toolNames: ["ECHO_TEST", "REPLY", "IGNORE", "STOP"],
        },
        cardinality: 1,
        response: {
          json: {
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
        },
      },
      {
        name: "route-echo-post-turn-evaluation",
        match: {
          modelType: "TEXT_SMALL",
          input: { includes: "# Task: Post-turn evaluation" },
          toolNames: [],
        },
        cardinality: 1,
        response: {
          text: '{"factMemory":{"ops":[]},"preferences":{"ops":[]},"relationships":{"relationships":[]},"identities":{"identities":[]},"success":{"completed":true,"reason":"ECHO_TEST completed."},"ftu_goal_discovery":{"goalFound":false,"goal":"","confidence":0},"experiencePatterns":{"experiences":[]}}',
        },
      },
    ],
  },
  tags: ["smoke", "convo", "self-test"],
  description:
    "Registers a trivial ECHO_TEST plugin and verifies the scripted runner captures the action call with success=true.",

  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "register-echo-test-plugin",
      apply: async (ctx) => {
        const runtime = asRuntime(ctx.runtime);
        await runtime.registerPlugin(echoTestPlugin satisfies Plugin);
      },
    },
  ],
  cleanup: [
    {
      type: "custom",
      name: "unregister-echo-test-action",
      apply: (ctx) => {
        asRuntime(ctx.runtime).unregisterAction("ECHO_TEST");
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
