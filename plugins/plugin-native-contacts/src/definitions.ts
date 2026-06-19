import type { PermissionState } from "@capacitor/core";

export interface ContactSummary {
  id: string;
  lookupKey: string;
  displayName: string;
  phoneNumbers: string[];
  emailAddresses: string[];
  photoUri?: string;
  starred: boolean;
}

/** Runtime permission state for the contacts (READ/WRITE_CONTACTS) alias. */
export interface ContactsPermissionStatus {
  contacts: PermissionState;
}

export interface ListContactsOptions {
  query?: string;
  limit?: number;
}

export interface CreateContactOptions {
  displayName: string;
  phoneNumber?: string;
  phoneNumbers?: string[];
  emailAddress?: string;
  emailAddresses?: string[];
}

export interface ImportVCardOptions {
  vcardText: string;
}

export interface ImportedContactSummary extends ContactSummary {
  sourceName: string;
}

export interface ContactsPlugin {
  listContacts(
    options?: ListContactsOptions,
  ): Promise<{ contacts: ContactSummary[] }>;
  createContact(options: CreateContactOptions): Promise<{ id: string }>;
  importVCard(options: ImportVCardOptions): Promise<{
    imported: ImportedContactSummary[];
  }>;
  /** Current contacts (READ/WRITE_CONTACTS) permission state. Web: granted. */
  checkPermissions(): Promise<ContactsPermissionStatus>;
  /** Prompt for contacts access (no-op grant on web). Feature-gated; never
   *  requested at launch. */
  requestPermissions(): Promise<ContactsPermissionStatus>;
}
