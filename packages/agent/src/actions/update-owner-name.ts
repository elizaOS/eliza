/**
 * UPDATE_OWNER_NAME action — owner-only programmatic update of the configured
 * display name. Mirrors `PUT /api/config` writing `{ ui: { ownerName } }`,
 * which is the same path RelationshipsView's owner-edit control uses.
 *
 * Distinct from SET_USER_NAME, which is gated to client_chat and uses
 * conversational heuristics. UPDATE_OWNER_NAME takes a `name` parameter
 * directly and is invoked by the planner / explicit tool calls.
 */

import type { Action, ActionExample, HandlerOptions } from "@elizaos/core";
import {
  fetchConfiguredOwnerName,
  OWNER_NAME_MAX_LENGTH,
  persistConfiguredOwnerName,
} from "../services/owner-name.js";

type UpdateOwnerNameParams = {
  name?: string;
};

export const updateOwnerNameAction: Action = {
  name: "UPDATE_OWNER_NAME",
  contexts: ["settings", "contacts", "admin"],
  roleGate: { minRole: "OWNER" },
  similes: ["SET_OWNER_NAME", "CHANGE_OWNER_NAME", "UPDATE_DISPLAY_NAME"],
  description:
    "Update the configured owner display name. Owner-only. Persists to the eliza.json `ui.ownerName` field, the same path the Relationships owner-edit field writes.",
  descriptionCompressed:
    "update configur owner display name owner-only persist eliza json ui ownername field, same path Relationships owner-edit field write",

  validate: async () => true,

  parameters: [
    {
      name: "name",
      description: `New owner display name (1–${OWNER_NAME_MAX_LENGTH} chars after trimming).`,
      required: true,
      schema: { type: "string" as const },
    },
  ],

  handler: async (_runtime, _message, _state, options) => {
    const params = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as UpdateOwnerNameParams;
    const raw = typeof params.name === "string" ? params.name.trim() : "";
    const name = raw.slice(0, OWNER_NAME_MAX_LENGTH);

    if (!name) {
      return {
        text: "UPDATE_OWNER_NAME requires a non-empty name parameter.",
        success: false,
        values: { success: false, error: "INVALID_PARAMETERS" },
        data: { actionName: "UPDATE_OWNER_NAME" },
      };
    }

    const previous = await fetchConfiguredOwnerName();
    const saved = await persistConfiguredOwnerName(name);
    if (!saved) {
      return {
        text: `Failed to persist owner name "${name}".`,
        success: false,
        values: { success: false, error: "PERSIST_FAILED" },
        data: { actionName: "UPDATE_OWNER_NAME", name },
      };
    }

    return {
      text: previous
        ? `Owner name updated from "${previous}" to "${name}".`
        : `Owner name set to "${name}".`,
      success: true,
      values: { success: true, name, previous: previous ?? null },
      data: {
        actionName: "UPDATE_OWNER_NAME",
        name,
        previous: previous ?? null,
      },
    };
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Change my display name to Sam." },
      },
      {
        name: "{{agentName}}",
        content: { text: 'Owner name set to "Sam".' },
      },
    ],
  ] as ActionExample[][],
};
