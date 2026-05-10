/**
 * Planner — action handler hangs longer than its timeout.
 *
 * The scenario registers a one-off plugin that exposes a single action,
 * `SCENARIO_HANG`, whose handler awaits a never-resolving promise so it
 * always exceeds the runtime's per-action timeout. The user's prompt is
 * crafted to invoke that action by name. The agent must:
 *   - surface a timeout-related error / acknowledgment to the user
 *   - NOT silently swallow the failure
 *   - NOT claim success
 *
 * Failure modes guarded:
 *   - hung action causes the entire planner loop to stall without any
 *     user-visible signal
 *   - agent claims "done" when nothing happened
 *   - agent retries forever
 *
 * Cited: 03-coverage-gap-matrix.md row "Action timeout" — listed NONE; no
 * scenario covers this.
 */

import type {
  Action,
  AgentRuntime,
  HandlerCallback,
  Memory,
  Plugin,
  State,
} from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";

const HANG_ACTION_NAME = "SCENARIO_HANG";

const hangAction: Action = {
  name: HANG_ACTION_NAME,
  similes: ["HANG_FOREVER"],
  description:
    "Test-only action that intentionally hangs forever to exercise the action-timeout path. Used by the lifeops.planner.action-timeout scenario.",
  validate: async () => true,
  examples: [],
  handler: async (
    _runtime: AgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ) => {
    // Never-resolving promise. The runtime's per-action timeout (default
    // 30s) must trip and surface an error.
    await new Promise<never>(() => {
      /* never resolves */
    });
    if (callback) {
      await callback({
        text: "this should never run",
      });
    }
    return { success: false, text: "this should never return" };
  },
};

const hangPlugin: Plugin = {
  name: "scenario-hang-test",
  description:
    "Test-only plugin that registers SCENARIO_HANG to exercise the action-timeout path.",
  actions: [hangAction],
};

function asRuntime(value: unknown): AgentRuntime {
  if (!value || typeof value !== "object" || !("registerPlugin" in value)) {
    throw new Error(
      "action-timeout scenario seed: runtime did not expose registerPlugin",
    );
  }
  return value as AgentRuntime;
}

function checkAgentSurfacedTimeout(ctx: ScenarioContext): string | undefined {
  // The hang action might still register as called (the handler started)
  // but its result must indicate failure / timeout.
  const hangCalls = ctx.actionsCalled.filter(
    (a) => a.actionName === HANG_ACTION_NAME,
  );
  if (hangCalls.length > 0) {
    const lastCall = hangCalls[hangCalls.length - 1];
    if (lastCall.result?.success === true) {
      return `${HANG_ACTION_NAME} reported success despite the handler hanging forever. The runtime's action timeout did not trip.`;
    }
  }

  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  if (reply.length === 0) {
    return "agent produced no reply — timeout was silently swallowed";
  }

  const timeoutMarkers = [
    "timeout",
    "timed out",
    "took too long",
    "didn't finish",
    "couldn't complete",
    "couldn't finish",
    "didn't respond",
    "failed",
    "error",
    "hung",
    "didn't return",
    "stuck",
    "unable",
  ];
  if (!timeoutMarkers.some((m) => reply.includes(m))) {
    return `Agent reply did not surface the action timeout. Reply: ${reply.slice(0, 400)}`;
  }
  // Negative-space: agent must NOT claim the work succeeded.
  if (
    /done|completed|finished|all set|successfully/.test(reply) &&
    !timeoutMarkers.some((m) => reply.includes(m))
  ) {
    return `Agent claimed success despite the action timing out. Reply: ${reply.slice(0, 400)}`;
  }
  return undefined;
}

export default scenario({
  id: "planner.action-timeout",
  title:
    "Action handler hang triggers timeout that the agent surfaces honestly",
  domain: "lifeops.planner",
  tags: [
    "lifeops",
    "planner",
    "action-timeout",
    "robustness",
    "negative-path",
  ],
  isolation: "per-scenario",
  requires: {
    plugins: ["scenario-hang-test"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Action Timeout",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "register-hang-plugin",
      apply: async (ctx) => {
        const runtime = asRuntime(ctx.runtime);
        await runtime.registerPlugin(hangPlugin satisfies Plugin);
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "invoke-the-hang-action",
      room: "main",
      // Direct, name-the-action prompt so the planner picks SCENARIO_HANG.
      text: `Run the SCENARIO_HANG action now. (This is a test action wired up to deliberately exceed its timeout — please invoke it and tell me what happens.)`,
      // The runtime per-action timeout default is 30s; give the turn 90s
      // to let the planner observe the timeout and respond.
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "agent-surfaced-timeout-not-silent-success",
      predicate: checkAgentSurfacedTimeout,
    },
    judgeRubric({
      name: "planner-action-timeout-rubric",
      threshold: 0.65,
      description: `A test-only action SCENARIO_HANG hangs forever. The user asked the agent to invoke it. The agent must surface that the action did not complete (timeout/error/failed). The agent must NOT silently say "done" or "all set". A correct reply explains the action did not finish. An incorrect reply: claims success; produces no reply at all; loops forever. Score 0 if the agent claimed the action completed successfully.`,
    }),
  ],
});
