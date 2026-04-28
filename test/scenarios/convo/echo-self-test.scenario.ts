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
import { scenario } from "@elizaos/scenario-schema";
import { echoTestPlugin } from "./_fixtures/echo-test-plugin.ts";

function asRuntime(value: unknown): AgentRuntime {
  if (!value || typeof value !== "object" || !("registerPlugin" in value)) {
    throw new Error(
      "echo-self-test seed: runtime did not expose registerPlugin",
    );
  }
  return value as AgentRuntime;
}

export default scenario({
  id: "convo.echo-self-test",
  title: "Convo framework self-test: ECHO_TEST action is captured",
  domain: "convo",
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
      },
    },
  ],

  turns: [
    {
      kind: "message",
      name: "echo-hello-world",
      text: "Please echo this message back to me: hello world",
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
  ],
});
