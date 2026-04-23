export interface ContactSummary {
  id: string;
  displayName: string;
  phoneNumbers: string[];
  photoUri?: string;
}

export interface ListContactsOptions {
  query?: string;
  limit?: number;
}

export interface CreateContactOptions {
  displayName: string;
  phoneNumber?: string;
}

export interface ContactsPlugin {
  listContacts(options?: ListContactsOptions): Promise<{ contacts: ContactSummary[] }>;
  createContact(options: CreateContactOptions): Promise<{ id: string }>;
}
