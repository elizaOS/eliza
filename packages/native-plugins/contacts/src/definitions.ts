export interface ContactSummary {
  id: string;
  lookupKey: string;
  displayName: string;
  phoneNumbers: string[];
  emailAddresses: string[];
  photoUri?: string;
  starred: boolean;
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
}
