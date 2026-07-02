/**
 * Keyless per-plugin e2e for `@elizaos/plugin-relationships` (issue #8801).
 *
 * Exercises the plugin's `KNOWLEDGE_GRAPH` umbrella action end-to-end against
 * the runtime-owned knowledge graph (no external API, no credentials). The
 * `list` op reads the per-agent EntityStore (backed by the SQL plugin's
 * app_lifeops tables) and reports the entities in the graph — fully
 * deterministic, no model calls.
 *
 * Two harness facts shape this scenario:
 *
 *  1. The core runtime ships a built-in `native-features` plugin whose internal
 *     name is also "relationships". The scenario harness normalizes the required
 *     package "@elizaos/plugin-relationships" to that same "relationships" name,
 *     so it treats the package as already registered and never auto-loads the
 *     real plugin that owns KNOWLEDGE_GRAPH. The seed therefore registers that
 *     action directly (the same synthetic-registration the harness uses for
 *     plugin-app-control).
 *
 *  2. `KNOWLEDGE_GRAPH` is an op-dispatched action with no declared `parameters`
 *     schema (op/kind/limit are read from `options.parameters` and validated
 *     per-op in the handler). Under the strict LLM proxy the planner tool schema
 *     is closed, so a tool-call cannot carry the `op` argument. The action is
 *     therefore driven directly via an `action` turn with `options.parameters`,
 *     which runs the real handler against the real KnowledgeGraphService.
 */
import type { Action, AgentRuntime } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  describeCalls,
  successfulActionData,
} from "../_helpers/effect-assertions.ts";

const KNOWLEDGE_GRAPH = "KNOWLEDGE_GRAPH";
type R = AgentRuntime & {
  registerAction?: (action: Action) => void;
};

export default scenario({
  lane: "pr-deterministic",
  id: "relationships.list-entities",
  title: "Relationships: list entities in the knowledge graph",
  domain: "relationships",
  tags: ["smoke", "relationships", "knowledge-graph"],
  description:
    "Lists the entities in the runtime knowledge graph through the KNOWLEDGE_GRAPH action's `list` op — keyless, reads the per-agent EntityStore directly.",

  requires: { plugins: ["@elizaos/plugin-relationships"] },
  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "register-knowledge-graph-action",
      apply: async (ctx) => {
        const runtime = ctx.runtime as R;
        const { entityAction } = (await import(
          "@elizaos/plugin-relationships"
        )) as { entityAction: Action };
        runtime.registerAction?.(entityAction);
        return undefined;
      },
    },
  ],

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Relationships",
    },
  ],

  turns: [
    {
      kind: "action",
      name: "list-entities",
      actionName: KNOWLEDGE_GRAPH,
      text: "List the entities in my knowledge graph.",
      options: { parameters: { op: "list" } },
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find(
          (a) => a.actionName === KNOWLEDGE_GRAPH,
        );
        if (!call) {
          return `Expected ${KNOWLEDGE_GRAPH} but got: ${turn.actionsCalled
            .map((a) => a.actionName)
            .join(", ")}`;
        }
        if (!call.result?.success) {
          return `${KNOWLEDGE_GRAPH} did not succeed: ${
            call.error?.message ?? call.result?.text ?? "unknown error"
          }`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: KNOWLEDGE_GRAPH,
      status: "success",
      minCount: 1,
    },
    {
      // Effect proof (#11381): the list op really read the per-agent
      // EntityStore — a fresh graph must surface an empty entities array in
      // the result payload, not just handler success.
      type: "custom",
      name: "entity-store-read-effect",
      predicate: (ctx) => {
        const data = successfulActionData(ctx, KNOWLEDGE_GRAPH);
        if (!data) {
          return `no successful ${KNOWLEDGE_GRAPH} result data; calls: ${describeCalls(ctx)}`;
        }
        if (data.op !== "list") {
          return `expected result.data.op "list", saw ${String(data.op ?? "(missing)")}`;
        }
        if (!Array.isArray(data.entities)) {
          return `expected result.data.entities array from the EntityStore, saw ${JSON.stringify(data.entities ?? null)}`;
        }
        if (data.entities.length !== 0) {
          return `fresh knowledge graph must have no entities; saw ${data.entities.length}`;
        }
      },
    },
  ],
});
