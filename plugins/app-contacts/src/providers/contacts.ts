/**
 * androidContacts provider — read-only Android address-book context.
 *
 * Listing contacts is state exposure, not an agent operation with side
 * effects. Surfaced as a dynamic provider so the planner can pull contact
 * context when relevant. PLACE_CALL on the Phone app remains the live
 * operation for actually dialling a contact.
 */

import { type ContactSummary, Contacts } from "@elizaos/capacitor-contacts";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";

export const CONTACTS_PROVIDER_NAME = "androidContacts";

const CONTACTS_PROVIDER_LIMIT = 50;

interface AndroidContactEntry {
  id: string;
  displayName: string;
  phones: string[];
  emails: string[];
  starred: boolean;
}

function toEntry(contact: ContactSummary): AndroidContactEntry {
  return {
    id: contact.id,
    displayName: contact.displayName ?? "",
    phones: contact.phoneNumbers,
    emails: contact.emailAddresses,
    starred: Boolean(contact.starred),
  };
}

export const contactsProvider: Provider = {
  name: CONTACTS_PROVIDER_NAME,
  description:
    "Read-only Android address-book contacts (id, display name, phone numbers, emails, starred) for resolving people referenced in chat.",
  descriptionCompressed: "Android contacts: id, name, phones, emails, starred.",
  dynamic: true,
  contexts: ["system"],

  get: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    try {
      const { contacts } = await Contacts.listContacts({
        limit: CONTACTS_PROVIDER_LIMIT,
      });
      const entries = contacts.map(toEntry);

      return {
        text: JSON.stringify({
          android_contacts: {
            count: entries.length,
            items: entries,
          },
        }),
        values: {
          contactsAvailable: entries.length > 0,
          contactsCount: entries.length,
        },
        data: {
          contacts: entries,
          count: entries.length,
          limit: CONTACTS_PROVIDER_LIMIT,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return {
        text: "",
        values: {
          contactsAvailable: false,
          contactsCount: 0,
          contactsError: message,
        },
        data: {
          contacts: [],
          count: 0,
          limit: CONTACTS_PROVIDER_LIMIT,
          error: message,
        },
      };
    }
  },
};
