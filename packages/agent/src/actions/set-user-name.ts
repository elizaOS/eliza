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

import type {
  Action,
  ActionExample,
  HandlerOptions,
  State,
} from "@elizaos/core";
import {
  getRecentMessagesData,
  getValidationKeywordTerms,
  textIncludesKeywordTerm,
} from "@elizaos/shared";
import {
  fetchConfiguredOwnerName,
  OWNER_NAME_MAX_LENGTH,
  persistConfiguredOwnerName,
} from "../services/owner-name.js";
import { hasSelectedActionContext } from "./context-signal.js";

const SET_USER_NAME_CONTEXT_TERMS = getValidationKeywordTerms(
  "action.setUserName.recentContext",
  {
    includeAllLocales: true,
  },
);
const SET_USER_NAME_CONTEXTS = [
  "settings",
  "contacts",
  "agent_internal",
] as const;

function recentMessagesMentionName(state: State): boolean {
  const lastTwo = getRecentMessagesData(state).slice(-2);
  return lastTwo.some((message) => {
    const text =
      typeof message.content?.text === "string" ? message.content.text : "";
    return SET_USER_NAME_CONTEXT_TERMS.some((term) =>
      textIncludesKeywordTerm(text, term),
    );
  });
}

export const setUserNameAction: Action = {
  name: "SET_USER_NAME",
  contexts: [...SET_USER_NAME_CONTEXTS],
  roleGate: { minRole: "OWNER" },

  similes: ["REMEMBER_NAME", "SAVE_NAME", "SET_NAME"],

  description:
    "Save the user's preferred display name so you can address them personally. " +
    "Use this when the user tells you their name or asks you to call them something. " +
    "This is a silent side action that does not produce chat text on its own.",
  descriptionCompressed:
    "save user preferr display name address personally use user tell name ask call someth silent side action produce chat text",

  validate: async (_runtime, message, state) => {
    const content = message.content as Record<string, unknown> | undefined;
    if (content?.source !== "client_chat") return false;

    const selectedContextMatches = hasSelectedActionContext(
      message,
      state,
      SET_USER_NAME_CONTEXTS,
    );
    const currentName = await fetchConfiguredOwnerName();
    if (currentName) {
      return (
        selectedContextMatches ||
        (state ? recentMessagesMentionName(state) : false)
      );
    }

    return (
      selectedContextMatches ||
      (state ? recentMessagesMentionName(state) : false)
    );
  },

  handler: async (_runtime, _message, _state, options) => {
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
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "By the way, everyone calls me Sam.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Got it, Sam.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Please call me Jordan from now on.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Sure thing, Jordan.",
        },
      },
    ],
  ] as ActionExample[][],
};
