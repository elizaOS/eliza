/**
 * androidContacts provider — read-only Android address-book context.
 *
 * Listing contacts is state exposure, not an agent operation with side
 * effects. Surfaced as a dynamic provider so the planner can pull contact
 * context when relevant. PLACE_CALL on the Phone app remains the live
 * operation for actually dialling a contact.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import {
  type ContactSummary,
  Contacts,
} from "@elizaos/plugin-native-contacts/bridge";

const CONTACTS_PROVIDER_NAME = "androidContacts";

// Provider render bound. The native query orders by display
// name ascending, so the window keeps the alphabetically-first
// contacts; a specific person stays resolvable on demand through
// the Contacts view's query-filtered list. The view's explicit
// complete-read path is untouched.
const CONTACTS_PROVIDER_LIMIT = 200;

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
    displayName: contact.displayName,
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
  contexts: ["contacts", "messaging"],
  contextGate: { anyOf: ["contacts", "messaging"] },
  cacheScope: "turn",
  roleGate: { minRole: "ADMIN" },
  cacheStable: false,

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    try {
      const { contacts } = await Contacts.listContacts({
        limit: CONTACTS_PROVIDER_LIMIT,
      });
      // Hitting the limit is the normal truncated case here, not
      // an incomplete-context error: the provider's contract is
      // resolving people referenced in chat, and targeted lookup
      // stays available through the Contacts view's query path.
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
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // error-policy:J4 explicit user-facing degrade — a native address-book
      // read failure is surfaced to the planner via `contactsError`/`error`
      // (never a fabricated empty contact list); reportError also makes it
      // observable in RECENT_ERRORS + owner-escalation.
      runtime.reportError?.(`${CONTACTS_PROVIDER_NAME}.provider`, error);
      return {
        text: JSON.stringify({
          android_contacts: { error: message },
        }),
        values: {
          contactsAvailable: false,
          contactsCount: 0,
          contactsError: message,
        },
        data: {
          contacts: [],
          count: 0,
          error: message,
        },
      };
    }
  },
};
