/**
 * elizaOS runtime plugin for the Contacts overlay app.
 *
 * Wraps the existing @elizaos/capacitor-contacts native plugin with a single
 * LIST_CONTACTS action. Session-gated so the action is only available while
 * the Contacts app is active.
 */

import { gatePluginSessionForHostedApp, hasRoleAccess } from "@elizaos/agent";
import { Contacts } from "@elizaos/capacitor-contacts";
import type {
  Action,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  Plugin,
} from "@elizaos/core";

const CONTACTS_APP_NAME = "@elizaos/app-contacts";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

const listContactsAction: Action = {
  name: "LIST_CONTACTS",
  similes: ["GET_CONTACTS", "SHOW_CONTACTS", "READ_CONTACTS"],
  description:
    "List names from the device address book. Android-only. Returns the display names of up to `limit` contacts (default 25).",
  descriptionCompressed: "List contact names from the device address book.",

  validate: async (runtime: IAgentRuntime, message: Memory) => {
    return hasRoleAccess(runtime, message, "USER");
  },

  handler: async (_runtime, _message, _state, options) => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | { limit?: number }
      | undefined;

    const requested = Number.isFinite(params?.limit)
      ? Number(params?.limit)
      : DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(requested)));

    const { contacts } = await Contacts.listContacts({ limit });
    const names = contacts
      .map((c) => c.displayName)
      .filter((name) => name.length > 0);

    return {
      text: names.length === 0 ? "No contacts found." : names.join(", "),
      success: true,
      data: { count: names.length, names },
    };
  },

  parameters: [
    {
      name: "limit",
      description: "Maximum number of contacts to return (1-200).",
      required: false,
      schema: {
        type: "number" as const,
        minimum: 1,
        maximum: MAX_LIMIT,
        default: DEFAULT_LIMIT,
      },
    },
  ],
};

const rawContactsPlugin: Plugin = {
  name: CONTACTS_APP_NAME,
  description:
    "Contacts overlay: read the device address book via the @elizaos/capacitor-contacts native plugin. Actions apply only while the Contacts app session is active.",
  actions: [listContactsAction],
};

export const appContactsPlugin: Plugin = gatePluginSessionForHostedApp(
  rawContactsPlugin,
  CONTACTS_APP_NAME,
);

export default appContactsPlugin;
