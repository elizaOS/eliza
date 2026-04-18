/**
 * SET_USER_NAME action — persists the user's preferred display name to config.
 *
 * Gated to app chat only (`source === "client_chat"`). Available when:
 *   - The name has not been set yet, OR
 *   - The last user + assistant messages mention the word "name"
 *
 * The handler PUTs `{ ui: { ownerName } }` to `/api/config` so the name is
 * persisted to disk and immediately visible to `resolveAppUserName`.
 */

import {
  fetchConfiguredOwnerName,
  OWNER_NAME_MAX_LENGTH,
  persistConfiguredOwnerName,
} from "../services/owner-name.js";
import type { Action, HandlerOptions, State } from "@elizaos/core";
import {
  getValidationKeywordTerms,
  textIncludesKeywordTerm,
} from "@elizaos/shared/validation-keywords";
import { hasOwnerAccess } from "../security/access.js";

const SET_USER_NAME_CONTEXT_TERMS = getValidationKeywordTerms(
  "action.setUserName.recentContext",
  {
    includeAllLocales: true,
  },
);

function recentMessagesMentionName(state: State): boolean {
  const recent =
    (state as Record<string, unknown>).recentMessages ??
    (state as Record<string, unknown>).recentMessagesData ??
    [];
  if (!Array.isArray(recent)) return false;

  const lastTwo = recent.slice(-2);
  return lastTwo.some((m: Record<string, unknown>) => {
    const content = m.content as Record<string, unknown> | undefined;
    const text = (content?.text as string) ?? "";
    return SET_USER_NAME_CONTEXT_TERMS.some((term) =>
      textIncludesKeywordTerm(text, term),
    );
  });
}

export const setUserNameAction: Action = {
  name: "SET_USER_NAME",

  similes: ["REMEMBER_NAME", "SAVE_NAME", "SET_NAME"],

  description:
    "Save the user's preferred display name so you can address them personally. " +
    "Use this when the user tells you their name or asks you to call them something. " +
    "This is a silent side action that does not produce chat text on its own.",

  validate: async (runtime, message, state) => {
    const content = message.content as Record<string, unknown> | undefined;
    if (content?.source !== "client_chat") return false;
    if (!(await hasOwnerAccess(runtime, message))) return false;

    const currentName = await fetchConfiguredOwnerName();
    if (currentName) {
      return state ? recentMessagesMentionName(state) : false;
    }

    return true;
  },

  handler: async (runtime, _message, _state, options) => {
    if (!(await hasOwnerAccess(runtime, _message))) {
      return {
        text: "",
        success: false,
        data: { error: "PERMISSION_DENIED" },
      };
    }

    const params = (options as HandlerOptions | undefined)?.parameters as
      | { name?: string }
      | undefined;
    const name = params?.name?.trim().slice(0, OWNER_NAME_MAX_LENGTH);

    if (!name) return { text: "", success: false };

    try {
      const saved = await persistConfiguredOwnerName(name);
      if (!saved) return { text: "", success: false };
    } catch {
      return { text: "", success: false };
    }

    return {
      text: "",
      success: true,
      data: { name },
    };
  },

  parameters: [
    {
      name: "name",
      description: "The user's preferred display name to remember.",
      required: true,
      schema: { type: "string" as const },
    },
  ],
};
