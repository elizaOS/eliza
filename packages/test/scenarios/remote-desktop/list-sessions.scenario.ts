/**
 * Keyless per-plugin e2e for `@elizaos/plugin-remote-desktop` (issue #8801).
 *
 * Exercises the owner-only `REMOTE_DESKTOP` umbrella action end-to-end with no
 * live credentials, no data plane, and no device hardware. A "list active
 * remote sessions" request routes through the action's `list` subaction, which
 * reads the in-process RemoteSessionService store (empty on a fresh runtime) and
 * reports no active sessions. Fully deterministic: the `list` subaction makes no
 * `useModel`/`fetch` call and the planner trust path in resolveActionArgs short-
 * circuits (action=list has no required params), so the only model calls are the
 * stage-1 response handler and the action planner (REMOTE_DESKTOP sets
 * suppressPostActionContinuation, mirroring the inbox keyless scenario).
 */
import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  describeCalls,
  successfulActionData,
} from "../_helpers/effect-assertions.ts";

const REMOTE_DESKTOP = "REMOTE_DESKTOP";
type R = AgentRuntime & {
  scenarioLlmFixtures?: {
    register: (...f: Array<Record<string, unknown>>) => void;
  };
};

export default scenario({
  lane: "pr-deterministic",
  id: "remote-desktop.list-sessions",
  title: "Remote desktop: list active sessions",
  domain: "remote-desktop",
  tags: ["smoke", "remote-desktop", "connector"],
  description:
    "Lists active remote-desktop sessions through the REMOTE_DESKTOP umbrella action against an empty in-process session store — keyless, no data plane, no device.",

  requires: { plugins: ["@elizaos/plugin-remote-desktop"] },
  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "remote-desktop-fixtures",
      apply: async (ctx) => {
        const runtime = ctx.runtime as R;
        runtime.scenarioLlmFixtures?.register(
          {
            name: "remote-desktop-stage1",
            match: {
              modelType: ModelType.RESPONSE_HANDLER,
              input: (v: string) => v.includes("remote"),
              toolName: "HANDLE_RESPONSE",
            },
            response: {
              contexts: ["general"],
              intents: ["remote-desktop"],
              replyText: "",
              threadOps: [],
              candidateActionNames: [REMOTE_DESKTOP],
            },
            times: 1,
          },
          {
            name: "remote-desktop-planner",
            match: {
              modelType: ModelType.ACTION_PLANNER,
              input: (v: string) => v.includes("remote"),
              toolName: REMOTE_DESKTOP,
            },
            response: {
              text: "",
              thought: "List active remote-desktop sessions.",
              messageToUser: "",
              completed: true,
              finishReason: "tool-calls",
              toolCalls: [
                {
                  id: "call-remote-desktop",
                  name: REMOTE_DESKTOP,
                  type: "function",
                  arguments: { action: "list" },
                },
              ],
            },
            times: 1,
          },
          {
            // After the REMOTE_DESKTOP tool returns, the runtime makes a final
            // RESPONSE_HANDLER (no HANDLE_RESPONSE tool) to decide FINISH vs
            // CONTINUE; the empty session list is terminal, so FINISH.
            name: "remote-desktop-decision",
            match: (call: { modelType: string; toolNames: string[] }) =>
              call.modelType === ModelType.RESPONSE_HANDLER &&
              !call.toolNames.includes("HANDLE_RESPONSE"),
            response: {
              success: true,
              decision: "FINISH",
              thought: "No active remote sessions; nothing more to do.",
              messageToUser: "There are no active remote sessions right now.",
            },
            times: 1,
          },
        );
        return undefined;
      },
    },
  ],

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Remote desktop",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "list",
      text: "List my active remote desktop sessions.",
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find(
          (a) => a.actionName === REMOTE_DESKTOP,
        );
        if (!call) {
          return `Expected ${REMOTE_DESKTOP} but got: ${turn.actionsCalled
            .map((a) => a.actionName)
            .join(", ")}`;
        }
        if (!call.result?.success) {
          return `${REMOTE_DESKTOP} did not succeed: ${
            call.error?.message ?? call.result?.text ?? "unknown error"
          }`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: REMOTE_DESKTOP,
      status: "success",
      minCount: 1,
    },
    {
      // Effect proof (#11381): the `list` subaction really read the
      // RemoteSessionService store — a fresh runtime must yield an empty
      // sessions array in the result payload, not just handler success.
      type: "custom",
      name: "remote-desktop-list-effect",
      predicate: (ctx) => {
        const data = successfulActionData(ctx, REMOTE_DESKTOP);
        if (!data) {
          return `no successful ${REMOTE_DESKTOP} result data; calls: ${describeCalls(ctx)}`;
        }
        if (data.subaction !== "list") {
          return `expected result.data.subaction "list", saw ${String(data.subaction ?? "(missing)")}`;
        }
        if (!Array.isArray(data.sessions)) {
          return `expected result.data.sessions array from the session store, saw ${JSON.stringify(data.sessions ?? null)}`;
        }
        if (data.sessions.length !== 0) {
          return `fresh RemoteSessionService store must be empty; saw ${data.sessions.length} session(s)`;
        }
      },
    },
  ],
});
