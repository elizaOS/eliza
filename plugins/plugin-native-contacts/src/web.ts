import { WebPlugin } from "@capacitor/core";

import type {
  ContactSummary,
  ContactsPlugin,
  CreateContactOptions,
  ImportedContactSummary,
  ImportVCardOptions,
  ListContactsOptions,
} from "./definitions";

export class ContactsWeb extends WebPlugin implements ContactsPlugin {
  async listContacts(
    _options?: ListContactsOptions,
  ): Promise<{ contacts: ContactSummary[] }> {
    return { contacts: [] };
  }

  async createContact(_options: CreateContactOptions): Promise<{ id: string }> {
    throw new Error("Contacts are only available on Android.");
  }

  async importVCard(
    _options: ImportVCardOptions,
  ): Promise<{ imported: ImportedContactSummary[] }> {
    throw new Error("Contact imports are only available on Android.");
  }
}
