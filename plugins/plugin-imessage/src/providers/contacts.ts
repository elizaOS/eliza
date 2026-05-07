/**
 * Contacts provider for the iMessage plugin.
 *
 * Injects the user's Apple Contacts (as loaded by `IMessageService` at
 * startup) into the agent's state so the LLM can resolve a person's name
 * ("text Shaw") to an actual handle it can pass to unified `SEND_MESSAGE`.
 * Without this provider, the agent has no way to bridge from a
 * contact name to a phone number or email, since the sendMessage action
 * only accepts raw handles (E.164 phones, emails, or `chat_id:` refs).
 *
 * The underlying contacts map is keyed by normalized handle → name, so
 * the same person with both a phone and an email appears as two entries
 * pointing at the same name. This provider inverts that: one line per
 * unique name, listing every handle that person has, so the LLM can
 * pick the best channel (phone for SMS/iMessage, email for iMessage-on-
 * Mac delivery).
 *
 * The provider is marked `dynamic: true` so it only runs when the agent
 * actually composes state for a turn (not on every provider scan), and
 * it returns an empty result when the service is unavailable or the
 * contacts map is empty, instead of throwing.
 */

import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import type { IMessageService } from "../service.js";
import { IMESSAGE_SERVICE_NAME } from "../types.js";

/** Max number of contacts to dump into a single state injection. Over
 * this many and we truncate with a summary line so we never blow the
 * agent's context window on a user with thousands of contacts. */
const MAX_CONTACTS_IN_STATE = 200;

interface ContactGroup {
  name: string;
  handles: string[];
}

/**
 * Collapse the handle-keyed ContactsMap into one entry per unique name,
 * with every handle that person owns. Sorted alphabetically by name for
 * deterministic prompt output (which helps with prompt caching).
 */
function groupContactsByName(contacts: ReadonlyMap<string, { name: string }>): ContactGroup[] {
  const byName = new Map<string, Set<string>>();
  for (const [handle, { name }] of contacts) {
    if (!name) continue;
    const key = name.trim();
    if (!key) continue;
    let handles = byName.get(key);
    if (!handles) {
      handles = new Set<string>();
      byName.set(key, handles);
    }
    handles.add(handle);
  }

  const groups: ContactGroup[] = [];
  for (const [name, handles] of byName) {
    groups.push({
      name,
      handles: Array.from(handles).sort((a, b) => a.localeCompare(b)),
    });
  }
  groups.sort((a, b) => a.name.localeCompare(b.name));
  return groups;
}

export const contactsProvider: Provider = {
  name: "imessageContacts",
  description:
    "Exposes the user's Apple Contacts (name → phone/email) so the agent can resolve a person's name to a handle for unified SEND_MESSAGE.",
  descriptionCompressed: "Apple Contacts (name→phone/email) for iMessage handle resolution.",

  dynamic: true,
  contextGate: { anyOf: ["phone", "social", "connectors"] },
  cacheStable: false,
  cacheScope: "turn",
  contexts: ["phone", "social", "connectors"],

  get: async (runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> => {
    try {
      const imessageService = runtime.getService<IMessageService>(IMESSAGE_SERVICE_NAME);

      if (!imessageService) {
        return {
          data: { available: false, reason: "service-not-registered" },
          values: {},
          text: "",
        };
      }

      const contactsMap = imessageService.getContacts();
      if (!contactsMap || contactsMap.size === 0) {
        return {
          data: { available: false, reason: "contacts-map-empty" },
          values: {},
          text: "",
        };
      }

      const groups = groupContactsByName(contactsMap);
      if (groups.length === 0) {
        return {
          data: { available: false, reason: "no-named-contacts" },
          values: {},
          text: "",
        };
      }

      const truncated = groups.length > MAX_CONTACTS_IN_STATE;
      const shown = truncated ? groups.slice(0, MAX_CONTACTS_IN_STATE) : groups;

      const lines: string[] = [
        `The user's Apple Contacts are available for iMessage. ${groups.length} contact(s) loaded${truncated ? ` (showing first ${MAX_CONTACTS_IN_STATE})` : ""}.`,
        "When the user asks you to text, message, or iMessage a person by name,",
        "look up that person below and pass their phone number (preferred) or email",
        'to SEND_MESSAGE with source "imessage". If the name is ambiguous or',
        "missing, ask the user to clarify instead of guessing.",
        "",
        "Contacts:",
      ];
      for (const group of shown) {
        lines.push(`- ${group.name}: ${group.handles.join(", ")}`);
      }

      return {
        data: {
          available: true,
          total: groups.length,
          shown: shown.length,
          truncated,
        },
        values: {
          contactCount: groups.length,
        },
        text: lines.join("\n"),
      };
    } catch (error) {
      return {
        data: {
          available: false,
          reason: "contacts-provider-error",
          error: error instanceof Error ? error.message : String(error),
        },
        values: {},
        text: "",
      };
    }
  },
};
