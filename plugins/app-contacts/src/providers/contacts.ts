/**
 * CONTACTS provider - read-only address-book context for the Contacts app.
 *
 * Listing contacts is state exposure, not an agent operation with side
 * effects. Keep it as a dynamic provider so the planner can request contact
 * context when needed, while PLACE_CALL remains the live Phone action.
 */

import { type ContactSummary, Contacts } from "@elizaos/capacitor-contacts";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";

export const CONTACTS_PROVIDER_NAME = "CONTACTS";

const CONTACTS_PROVIDER_LIMIT = 50;

function formatContact(contact: ContactSummary): string {
  const fields = [
    `name: ${contact.displayName || "(unnamed)"}`,
    contact.phoneNumbers.length > 0
      ? `phones: ${contact.phoneNumbers.join(", ")}`
      : null,
    contact.emailAddresses.length > 0
      ? `emails: ${contact.emailAddresses.join(", ")}`
      : null,
  ].filter(Boolean);

  return `- ${fields.join("; ")}`;
}

export const contactsProvider: Provider = {
  name: CONTACTS_PROVIDER_NAME,
  description:
    "Provides read-only Android address-book contacts for resolving names, phone numbers, and email addresses.",
  descriptionCompressed:
    "Android contacts: names, phone numbers, emails for contact resolution.",
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
      const text =
        contacts.length === 0
          ? "contacts[0]: none"
          : [
              `contacts[${contacts.length}]:`,
              ...contacts.map(formatContact),
            ].join("\n");

      return {
        text,
        values: {
          contactsAvailable: contacts.length > 0,
          contactsCount: contacts.length,
        },
        data: {
          contacts,
          count: contacts.length,
          limit: CONTACTS_PROVIDER_LIMIT,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return {
        text: `contacts_error: ${message}`,
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
