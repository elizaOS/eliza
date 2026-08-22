/**
 * Ported from `eliza/packages/app-core/test/convo-testing/scenarios/greeting-dynamic.convo.test.ts`.
 *
 * The original scenario was dynamic/LLM-driven — an evaluator LLM steered
 * the conversation toward triggering the `GREET_USER` action within
 * `maxTurns: 3`, starting from the seed message below. Original metadata:
 *
 *   goal:             "Have a natural greeting conversation with the agent
 *                      so it welcomes you"
 *   expectedActions:  ["GREET_USER"]
 *   maxTurns:         3
 *   initialMessage:   "Hey there! I'm new here, just wanted to say hi."
 *   turnTimeoutMs:    120_000
 *
 * The current `@elizaos/scenario-runner` contract is scripted, so this file is
 * the compatibility port: a single scripted turn with deterministic routing
 * fixtures proves the `GREET_USER` action is selected and succeeds.
 */

import type { AgentRuntime, Plugin } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";
import { greetTestPlugin } from "./_fixtures/greet-test-plugin.ts";

const GREETING_INPUT = "Hello!";

type RuntimeWithPluginRegistration = AgentRuntime;

function asRuntime(value: unknown): RuntimeWithPluginRegistration {
  if (!value || typeof value !== "object" || !("registerPlugin" in value)) {
    throw new Error(
      "greeting-dynamic seed: runtime did not expose registerPlugin",
    );
  }
  return value as RuntimeWithPluginRegistration;
}

export default scenario({
  lane: "pr-deterministic",
  modelFixtures: {
    mode: "fixtures",
    fixtures: [
      {
        name: "route-greeting-stage1",
        match: {
          modelType: "RESPONSE_HANDLER",
          input: { includes: GREETING_INPUT },
          toolNames: ["HANDLE_RESPONSE"],
        },
        response: {
          json: {
            contexts: ["general"],
            intents: ["greeting"],
            replyText: "Hello there.",
            threadOps: [],
            candidateActionNames: ["GREET_USER"],
          },
        },
      },
      {
        name: "route-greeting-planner",
        match: {
          modelType: "ACTION_PLANNER",
          input: { includes: GREETING_INPUT },
        },
        response: {
          json: {
            text: "",
            thought: "Call GREET_USER to welcome the user.",
            messageToUser: "Hello there.",
            completed: true,
            finishReason: "tool-calls",
            toolCalls: [
              {
                id: "call-greet-user",
                name: "GREET_USER",
                type: "function",
                arguments: {},
              },
            ],
          },
        },
      },
      {
        name: "route-greeting-post-turn-evaluation",
        match: {
          modelType: "TEXT_SMALL",
          input: { includes: "# Task: Post-turn evaluation" },
        },
        response: {
          text: '{"factMemory":{"ops":[]},"preferences":{"ops":[]},"relationships":{"relationships":[]},"identities":{"identities":[]},"success":{"completed":true,"reason":"GREET_USER completed."},"ftu_goal_discovery":{"goalFound":false,"goal":"","confidence":0},"experiencePatterns":{"experiences":[]}}',
        },
      },
    ],
  },
  id: "convo.greeting-dynamic",
  title: "Convo framework: greeting routes to GREET_USER",
  domain: "convo",
  // Keyless-deterministic: the trivial GREET_USER plugin runs in-memory and the
  // routing fixtures registered below force action selection under the
  // deterministic model provider. No external service or secret required.
  tags: ["smoke", "convo", "greeting"],
  description:
    "Scripted port of the dynamic greeting scenario: sends a single greeting and verifies the GREET_USER action is captured with success=true.",

  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "register-greet-test-plugin",
      apply: async (ctx) => {
        const runtime = asRuntime(ctx.runtime);
        await runtime.registerPlugin(greetTestPlugin satisfies Plugin);
      },
    },
  ],

  turns: [
    {
      kind: "message",
      name: "greet-hello",
      text: GREETING_INPUT,
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const greet = turn.actionsCalled.find(
          (action) => action.actionName === "GREET_USER",
        );
        if (!greet) {
          return `Expected GREET_USER action but got: ${turn.actionsCalled
            .map((action) => action.actionName)
            .join(", ")}`;
        }
        if (!greet.result?.success) {
          return `GREET_USER action did not succeed: ${
            greet.error?.message ?? "unknown error"
          }`;
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
      // Effect proof (#11381): the handler really received the inbound
      // greeting through the pipeline — its result text must embed the exact
      // user utterance, not merely success=true.
      type: "custom",
      name: "greeting-payload-roundtrip-effect",
      predicate: (ctx) => {
        const call = ctx.actionsCalled.find(
          (action) =>
            action.actionName === "GREET_USER" &&
            action.result?.success === true,
        );
        if (!call) {
          return "no successful GREET_USER call captured";
        }
        const expected = `Hello there! Great to meet you. You said: "${GREETING_INPUT}"`;
        if (call.result?.text !== expected) {
          return `expected the greeting ${JSON.stringify(expected)} in result.text, saw ${JSON.stringify(call.result?.text ?? null)}`;
        }
      },
    },
  ],
});
