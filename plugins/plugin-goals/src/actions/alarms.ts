/**
 * OWNER_ALARMS — wake/notification alarms with repeat rules.
 *
 * STUB. The current handler is in
 *   plugins/plugin-personal-assistant/src/actions/owner-surfaces.ts (alongside
 *   OWNER_REMINDERS). On the foundations pass the body moves here.
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

import { ALARM_ACTIONS, GOALS_CONTEXTS, GOALS_LOG_PREFIX } from "../types.ts";

export const ownerAlarmsAction: Action = {
  name: "OWNER_ALARMS",
  description:
    "Manage the owner's alarms (one-shot or repeating wake/notification alarms). Actions: create, update, delete, snooze, dismiss, list.",
  descriptionCompressed:
    "owner alarms: create|update|delete|snooze|dismiss|list",
  contexts: [...GOALS_CONTEXTS],
  contextGate: { anyOf: [...GOALS_CONTEXTS] },
  roleGate: { minRole: "ADMIN" },
  tags: [
    "domain:alarms",
    "capability:write",
    "capability:update",
    "capability:delete",
    "surface:owner",
  ],
  similes: ["ALARM", "SET_ALARM", "WAKE_UP", "WAKE_ME"],
  parameters: [
    {
      name: "action",
      description: "Action: create | update | delete | snooze | dismiss | list.",
      required: true,
      schema: { type: "string" as const, enum: [...ALARM_ACTIONS] },
    },
    {
      name: "id",
      description: "Alarm id.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "label",
      description: "Alarm label (create/update).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "fireAt",
      description: "ISO-8601 timestamp when the alarm should fire.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "repeatRule",
      description: "Repeat rule (RRULE-style, e.g. FREQ=DAILY).",
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
    // TODO(migrate): copy the OWNER_ALARMS handler from
    // plugins/plugin-personal-assistant/src/actions/owner-surfaces.ts.
    return {
      success: false,
      text: `${GOALS_LOG_PREFIX} OWNER_ALARMS not yet implemented (scaffold stub)`,
      data: { action: "noop", reason: "scaffold_stub" },
    };
  },
};
