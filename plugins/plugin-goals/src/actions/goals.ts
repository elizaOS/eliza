/**
 * OWNER_GOALS — owner-set long-horizon life goals.
 *
 * STUB. Full implementation lives in
 *   plugins/plugin-personal-assistant/src/actions/owner-surfaces.ts (OWNER_GOAL_ACTIONS,
 *   ownerGoalsAction). When the LifeOps decomposition lands the handler body
 *   moves here and `plugin-lifeops` re-exports this action.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

import { GOAL_ACTIONS, GOALS_CONTEXTS, GOALS_LOG_PREFIX } from "../types.ts";

export const ownerGoalsAction: Action = {
  name: "OWNER_GOALS",
  description:
    "Manage the owner's long-horizon life goals. Actions: create, update, delete, review. Goals carry a horizon (e.g. quarter, year, life) and feed routine + reminder generation.",
  descriptionCompressed:
    "owner goals: create|update|delete|review; long-horizon, drives routines",
  contexts: [...GOALS_CONTEXTS],
  contextGate: { anyOf: [...GOALS_CONTEXTS] },
  roleGate: { minRole: "ADMIN" },
  tags: [
    "domain:goals",
    "capability:write",
    "capability:update",
    "capability:delete",
    "surface:owner",
  ],
  similes: ["GOALS", "LIFE_GOALS", "SET_GOAL", "UPDATE_GOAL", "REVIEW_GOALS"],
  parameters: [
    {
      name: "action",
      description: "Action: create | update | delete | review.",
      required: true,
      schema: { type: "string" as const, enum: [...GOAL_ACTIONS] },
    },
    {
      name: "id",
      description: "Goal id (update/delete/review).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "title",
      description: "Goal title (create/update).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "description",
      description: "Longer goal description (create/update).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "horizon",
      description: "Time horizon: quarter | year | life | etc.",
      required: false,
      schema: { type: "string" as const },
    },
  ],
  validate: async (_runtime: IAgentRuntime): Promise<boolean> => true,
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    // TODO(migrate): copy the OWNER_GOALS dispatch from
    // plugins/plugin-personal-assistant/src/actions/owner-surfaces.ts (search for
    // OWNER_GOAL_ACTIONS / ownerGoalsAction). The handler should resolve the
    // owner scope, call into the goals repository, and emit a callback line.
    return {
      success: false,
      text: `${GOALS_LOG_PREFIX} OWNER_GOALS not yet implemented (scaffold stub)`,
      data: { action: "noop", reason: "scaffold_stub" },
    };
  },
};
