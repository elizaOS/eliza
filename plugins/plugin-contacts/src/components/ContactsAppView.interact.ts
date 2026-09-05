/**
 * Dispatches the Contacts view bundle's classified interaction operations.
 * Keeping the exact handler map keyed by the production declaration union
 * makes an undeclared operation or an unimplemented declaration a type error.
 */

import {
  Contacts,
  type CreateContactOptions,
} from "@elizaos/capacitor-contacts";
import { ElizaError } from "@elizaos/core";
import type { ContactsViewCapabilityId } from "../view-capabilities";
import { matchesQuery } from "./ContactsAppView.helpers";

type ContactsCapabilityHandler = (
  params?: Record<string, unknown>,
) => Promise<unknown>;

const COMPLETE_CONTACTS_READ_LIMIT = 2_147_483_647;

const CONTACTS_CAPABILITY_HANDLERS: Record<
  ContactsViewCapabilityId,
  ContactsCapabilityHandler
> = {
  "list-contacts": async (params) => {
    const query = typeof params?.query === "string" ? params.query.trim() : "";
    const result = await Contacts.listContacts({
      ...(query ? { query } : {}),
      limit: COMPLETE_CONTACTS_READ_LIMIT,
    });
    if (result.contacts.length === COMPLETE_CONTACTS_READ_LIMIT) {
      throw new ElizaError(
        "Contacts read reached the native bridge boundary; refusing to return a potentially incomplete address book.",
        {
          code: "NATIVE_CONTACTS_READ_INCOMPLETE",
          context: { limit: COMPLETE_CONTACTS_READ_LIMIT },
        },
      );
    }
    const contacts = query
      ? result.contacts.filter((contact) => matchesQuery(contact, query))
      : result.contacts;
    return {
      query,
      count: contacts.length,
      contacts: contacts.map((contact) => ({
        id: contact.id,
        lookupKey: contact.lookupKey,
        displayName: contact.displayName,
        phoneNumbers: contact.phoneNumbers,
        emailAddresses: contact.emailAddresses,
        starred: contact.starred,
      })),
    };
  },
  "create-contact": async (params) => {
    const displayName =
      typeof params?.displayName === "string" ? params.displayName.trim() : "";
    if (!displayName) throw new Error("displayName is required");
    const payload: CreateContactOptions = { displayName };
    const phoneNumber =
      typeof params?.phoneNumber === "string" ? params.phoneNumber.trim() : "";
    const emailAddress =
      typeof params?.emailAddress === "string"
        ? params.emailAddress.trim()
        : "";
    if (phoneNumber) payload.phoneNumber = phoneNumber;
    if (emailAddress) payload.emailAddress = emailAddress;
    const result = await Contacts.createContact(payload);
    return { created: true, id: result.id };
  },
  "import-vcard": async (params) => {
    const vcardText =
      typeof params?.vcardText === "string" ? params.vcardText.trim() : "";
    if (!vcardText) throw new Error("vcardText is required");
    const result = await Contacts.importVCard({ vcardText });
    return {
      imported: result.imported.length,
      contacts: result.imported.map((contact) => ({
        id: contact.id,
        lookupKey: contact.lookupKey,
        displayName: contact.displayName,
        phoneNumbers: contact.phoneNumbers,
        emailAddresses: contact.emailAddresses,
        starred: contact.starred,
        sourceName: contact.sourceName,
      })),
    };
  },
};

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (!Object.hasOwn(CONTACTS_CAPABILITY_HANDLERS, capability)) {
    throw new Error(`Unsupported capability "${capability}"`);
  }
  return CONTACTS_CAPABILITY_HANDLERS[capability as ContactsViewCapabilityId](
    params,
  );
}
