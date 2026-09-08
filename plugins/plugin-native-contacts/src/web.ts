/**
 * Web/node fallback bridge (`ContactsWeb`) for the Android-only contacts
 * plugin. Reads, writes and permission operations reject explicitly because
 * no contacts store exists off Android.
 */
import { WebPlugin } from "@capacitor/core";

import type {
  ContactSummary,
  ContactsPermissionStatus,
  ContactsPlugin,
  CreateContactOptions,
  ImportedContactSummary,
  ImportVCardOptions,
  ListContactsOptions,
} from "./definitions";

function normalizeLimit(limit: unknown): number | undefined {
  if (limit === undefined) return undefined;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("limit must be a positive safe integer");
  }
  return limit;
}

function nonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validateCreateContactOptions(options: CreateContactOptions): void {
  if (!nonEmptyString(options?.displayName)) {
    throw new Error("displayName is required");
  }
}

function validateImportVCardOptions(options: ImportVCardOptions): void {
  if (!nonEmptyString(options?.vcardText)) {
    throw new Error("vcardText is required");
  }
}

export class ContactsWeb extends WebPlugin implements ContactsPlugin {
  async listContacts(
    options?: ListContactsOptions,
  ): Promise<{ contacts: ContactSummary[] }> {
    normalizeLimit(options?.limit);
    throw this.unavailable("Contacts are only available on Android.");
  }

  async createContact(options: CreateContactOptions): Promise<{ id: string }> {
    validateCreateContactOptions(options);
    throw this.unavailable("Contacts are only available on Android.");
  }

  async importVCard(
    options: ImportVCardOptions,
  ): Promise<{ imported: ImportedContactSummary[] }> {
    validateImportVCardOptions(options);
    throw this.unavailable("Contact imports are only available on Android.");
  }

  async checkPermissions(): Promise<ContactsPermissionStatus> {
    throw this.unavailable("Contacts are only available on Android.");
  }

  async requestPermissions(): Promise<ContactsPermissionStatus> {
    throw this.unavailable("Contacts are only available on Android.");
  }
}
