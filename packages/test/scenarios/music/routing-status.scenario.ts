/**
 * Keyless per-plugin e2e for `@elizaos/plugin-music` (issue #8801).
 *
 * Exercises the MUSIC umbrella action end-to-end through its purely local
 * `set_routing` / `status` subaction — no external API, no live credentials,
 * no Discord client, no async generation. The planner selects
 * `action: "set_routing", routingAction: "status"`, which dispatches to the
 * in-process MANAGE_ROUTING handler. That handler reads the AudioRouter status
 * directly from the in-memory MusicService (no callback required) and returns
 * success. Deterministic under the strict LLM proxy.
 */
import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  describeCalls,
  successfulActionData,
  toRecord,
} from "../_helpers/effect-assertions.ts";

const MUSIC = "MUSIC";
type R = AgentRuntime & {
  scenarioLlmFixtures?: {
    register: (...f: Array<Record<string, unknown>>) => void;
  };
};

export default scenario({
  lane: "pr-deterministic",
  id: "music.routing-status",
  title: "Music: read routing status via the MUSIC action",
  domain: "music",
  tags: ["smoke", "music", "connector"],
  description:
    "Routes a 'show routing status' request through the MUSIC action's local set_routing/status subaction — keyless, no external API or client.",

  requires: { plugins: ["@elizaos/plugin-music"] },
  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "music-fixtures",
      apply: async (ctx) => {
        const runtime = ctx.runtime as R;
        runtime.scenarioLlmFixtures?.register(
          {
            name: "music-stage1",
            match: {
              modelType: ModelType.RESPONSE_HANDLER,
              input: (v: string) => v.includes("routing"),
              toolName: "HANDLE_RESPONSE",
            },
            response: {
              contexts: ["media"],
              intents: ["music"],
              replyText: "",
              threadOps: [],
              candidateActionNames: [MUSIC],
            },
            times: 1,
          },
          {
            name: "music-planner",
            match: {
              modelType: ModelType.ACTION_PLANNER,
              input: (v: string) => v.includes("routing"),
              toolName: MUSIC,
            },
            response: {
              text: "",
              thought: "Show the current audio routing status.",
              messageToUser: "",
              completed: true,
              finishReason: "tool-calls",
              toolCalls: [
                {
                  id: "call-music",
                  name: MUSIC,
                  type: "function",
                  arguments: { action: "set_routing", routingAction: "status" },
                },
              ],
            },
            times: 1,
          },
          {
            name: "music-decision",
            match: (call: { modelType: string; toolNames: string[] }) =>
              call.modelType === ModelType.RESPONSE_HANDLER &&
              !call.toolNames.includes("HANDLE_RESPONSE"),
            response: {
              success: true,
              decision: "FINISH",
              thought: "Routing status delivered; nothing more to do.",
              messageToUser: "Here is the current audio routing status.",
            },
            times: 1,
          },
        );
        return undefined;
      },
    },
  ],

  rooms: [
    { id: "main", source: "dashboard", channelType: "DM", title: "Music" },
  ],

  turns: [
    {
      kind: "message",
      name: "routing-status",
      text: "Show me the audio routing status.",
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find((a) => a.actionName === MUSIC);
        if (!call) {
          return `Expected ${MUSIC} but got: ${turn.actionsCalled
            .map((a) => a.actionName)
            .join(", ")}`;
        }
        if (!call.result?.success) {
          return `${MUSIC} did not succeed: ${
            call.error?.message ?? call.result?.text ?? "unknown error"
          }`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: MUSIC,
      status: "success",
      minCount: 1,
    },
    {
      // Effect proof (#11381): the set_routing/status subaction really read
      // the AudioRouter state off the in-memory MusicService — the result must
      // carry the router's status object (mode + empty active routes on a
      // fresh runtime), not just handler success.
      type: "custom",
      name: "music-routing-status-effect",
      predicate: (ctx) => {
        const data = successfulActionData(ctx, MUSIC);
        if (!data) {
          return `no successful ${MUSIC} result data; calls: ${describeCalls(ctx)}`;
        }
        const status = toRecord(data.status);
        if (!status) {
          return `expected result.data.status from MusicService.getRoutingStatus(); saw ${JSON.stringify(data).slice(0, 300)}`;
        }
        if (typeof status.mode !== "string" || status.mode.length === 0) {
          return `expected a routing mode string in status.mode, saw ${JSON.stringify(status.mode ?? null)}`;
        }
        if (!Array.isArray(status.activeRoutes)) {
          return `expected status.activeRoutes array, saw ${JSON.stringify(status.activeRoutes ?? null)}`;
        }
        if (status.activeRoutes.length !== 0) {
          return `fresh AudioRouter must report zero active routes; saw ${status.activeRoutes.length}`;
        }
        if (typeof status.zoneCount !== "number") {
          return `expected numeric status.zoneCount, saw ${JSON.stringify(status.zoneCount ?? null)}`;
        }
      },
    },
  ],
});
