/**
 * OWNER_ROUTINES — recurring routines (daily/weekly habits + cadences).
 *
 * STUB. Full handler currently lives at
 *   plugins/plugin-lifeops/src/actions/owner-surfaces.ts (OWNER_LIFE_ACTIONS,
 *   ownerRoutinesAction). Default routine packs are sourced from
 *   plugins/plugin-lifeops/src/default-packs/daily-rhythm.ts and
 *   plugins/plugin-lifeops/src/default-packs/habit-starters.ts.
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

import {
  GOALS_CONTEXTS,
  GOALS_LOG_PREFIX,
  ROUTINE_ACTIONS,
} from "../types.ts";

export const ownerRoutinesAction: Action = {
  name: "OWNER_ROUTINES",
  description:
    "Manage the owner's recurring routines (daily/weekly habits and cadences). Actions: create, update, delete, complete, skip, snooze, review.",
  descriptionCompressed:
    "owner routines: create|update|delete|complete|skip|snooze|review",
  contexts: [...GOALS_CONTEXTS],
  contextGate: { anyOf: [...GOALS_CONTEXTS] },
  roleGate: { minRole: "ADMIN" },
  tags: [
    "domain:goals",
    "domain:routines",
    "capability:write",
    "capability:update",
    "capability:delete",
    "surface:owner",
  ],
  similes: [
    "ROUTINES",
    "DAILY_ROUTINE",
    "WEEKLY_ROUTINE",
    "HABIT",
    "MORNING_ROUTINE",
    "NIGHT_ROUTINE",
  ],
  parameters: [
    {
      name: "action",
      description:
        "Action: create | update | delete | complete | skip | snooze | review.",
      required: true,
      schema: { type: "string" as const, enum: [...ROUTINE_ACTIONS] },
    },
    {
      name: "id",
      description: "Routine id.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "name",
      description: "Routine name (create/update).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "cadence",
      description: "Cadence: daily | weekdays | weekly | custom-cron.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "timeOfDay",
      description: "Local time of day, e.g. '07:00'.",
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
    // TODO(migrate): port handler body from
    // plugins/plugin-lifeops/src/actions/owner-surfaces.ts. Also migrate the
    // default packs from plugins/plugin-lifeops/src/default-packs/
    // (daily-rhythm, habit-starters) into a new src/default-packs/ folder in
    // this plugin during the foundations follow-up.
    return {
      success: false,
      text: `${GOALS_LOG_PREFIX} OWNER_ROUTINES not yet implemented (scaffold stub)`,
      data: { action: "noop", reason: "scaffold_stub" },
    };
  },
};
