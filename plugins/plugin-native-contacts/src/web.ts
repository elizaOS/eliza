/**
 * Web/node fallback bridge (`ContactsWeb`) for the Android-only contacts
 * plugin: `listContacts` returns an empty list, `createContact` and
 * `importVCard` reject, since no contacts store exists off Android.
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
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    throw new Error("limit must be between 1 and 500");
  }
  const normalized = Math.trunc(limit);
  if (normalized < 1 || normalized > 500) {
    throw new Error("limit must be between 1 and 500");
  }
  return normalized;
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
    return { contacts: [] };
  }

  async createContact(options: CreateContactOptions): Promise<{ id: string }> {
    validateCreateContactOptions(options);
    throw new Error("Contacts are only available on Android.");
  }

  async importVCard(
    options: ImportVCardOptions,
  ): Promise<{ imported: ImportedContactSummary[] }> {
    validateImportVCardOptions(options);
    throw new Error("Contact imports are only available on Android.");
  }

  // Web has no contacts permission model; report granted so the shared view
  // flow proceeds (listContacts then returns an empty list on web).
  async checkPermissions(): Promise<ContactsPermissionStatus> {
    return { contacts: "granted" };
  }

  async requestPermissions(): Promise<ContactsPermissionStatus> {
    return { contacts: "granted" };
  }
}
