// View-bundle `interact` capability handler, split out of ContactsAppView.tsx so
// that file exports only React components and stays Fast-Refresh-compatible
// (Vite would full-reload a component file that also exports a plain function).
// The view bundle re-exports `interact` via ./contacts-view-bundle.ts.

import {
  Contacts,
  type CreateContactOptions,
} from "@elizaos/capacitor-contacts";
import { loadContactsState } from "./ContactsAppView.helpers";

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (capability === "terminal-list-contacts") {
    const state = await loadContactsState({
      query: typeof params?.query === "string" ? params.query : undefined,
      limit: typeof params?.limit === "number" ? params.limit : undefined,
    });
    return {
      viewType: "tui",
      query: state.query,
      count: state.count,
      contacts: state.contacts.map((contact) => ({
        id: contact.id,
        lookupKey: contact.lookupKey,
        displayName: contact.displayName,
        phoneNumbers: contact.phoneNumbers,
        emailAddresses: contact.emailAddresses,
        starred: contact.starred,
      })),
    };
  }

  if (capability === "terminal-create-contact") {
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
    return { created: true, id: result.id, viewType: "tui" };
  }

  if (capability === "terminal-import-vcard") {
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
      viewType: "tui",
    };
  }

  throw new Error(`Unsupported capability "${capability}"`);
}
