// spec/os/android/contacts.md, "Story: Read my contacts only while I am looking at them"; spec/os/android/contacts.md, "Story: Change only the contact I reviewed"; spec/os/android/contacts.md, "Story: Name the numbers I am already looking at"; spec/os/android/paging.md, "Story: Page my records without repeats or gaps"
import type { HandoffOutcome, ReadKind } from "../../../gen/os__android__bridge.ts";
import type { ContactsInstall, ContactsState } from "../../../gen/os__android__contacts.ts";
import type { ActionJournalPlugin, StagedDeletion } from "./action-journal.ts";

export type ContactId = string & { readonly __brand: "ContactId" };
export type ContactVersion = string & { readonly __brand: "ContactVersion" };
export type ContactCursor = string & { readonly __brand: "ContactCursor" };

export type ContactPhoneKind =
  | "home"
  | "mobile"
  | "work"
  | "fax_work"
  | "fax_home"
  | "pager"
  | "other"
  | "callback"
  | "car"
  | "company_main"
  | "isdn"
  | "main"
  | "other_fax"
  | "radio"
  | "telex"
  | "tty_tdd"
  | "work_mobile"
  | "work_pager"
  | "assistant"
  | "mms";
export type ContactEmailKind = "home" | "work" | "other" | "mobile";
export type ContactCustomType = `custom:${string}`;
export type ContactPhoneType = ContactPhoneKind | ContactCustomType;
export type ContactEmailType = ContactEmailKind | ContactCustomType;

export interface AddressBookStatus {
  available: boolean;
  readable: boolean;
  writable: boolean;
}

export interface AddressBookContact {
  id: ContactId;
  lookup: string;
  name: string;
  revision: string | null;
  starred: boolean;
  phones: string[];
  emails: string[];
}

export type AddressBookIncompleteReason = "field-too-long" | "too-many-fields";

export interface IncompleteAddressBookContact {
  id: ContactId;
  incomplete: true;
  reason: AddressBookIncompleteReason;
}

export type AddressBookRow = AddressBookContact | IncompleteAddressBookContact;

export interface AddressBookPage {
  contacts: AddressBookRow[];
  next: ContactCursor | null;
}

export interface ContactPageAsk {
  query: string;
  limit?: number;
  cursor?: ContactCursor;
  kind?: ReadKind;
}

export interface ContactPhone {
  number: string;
  type: ContactPhoneType;
}

export interface ContactEmail {
  address: string;
  type: ContactEmailType;
}

export interface ContactDetail {
  id: ContactId;
  lookup: string;
  displayName: string;
  givenName: string;
  familyName: string;
  notes?: string;
  starred: boolean;
  phoneNumbers: ContactPhone[];
  emailAddresses: ContactEmail[];
  version: ContactVersion;
}

export type ReviewedContact = Pick<ContactDetail, "id" | "version">;

export interface ContactDraft {
  displayName: string;
  givenName?: string;
  familyName?: string;
  notes?: string;
  phoneNumbers: ContactPhone[];
  emailAddresses: ContactEmail[];
}

export type ContactSaveResult =
  | { status: "saved"; id: ContactId; version: ContactVersion }
  | { status: "saved"; id: null; version: null }
  | { status: "stale" | "not-found" | "failed" | "unknown" };

export type ContactRemoveResult =
  | { status: "queued"; deletion: StagedDeletion }
  | { status: "stale" | "not-found" | "failed" };

export type NameSurface = "phone" | "messages" | "call";

export interface NameScreen {
  surface: NameSurface;
  numbers: readonly string[];
}

export type DisplayOnlyName = string & { readonly __brand: "DisplayOnlyName" };

export interface ContactName {
  number: string;
  name: DisplayOnlyName | null;
  photo: string | null;
}

export type ContactDraftProblem =
  | "empty-contact"
  | "invalid-name"
  | "invalid-notes"
  | "too-many-fields"
  | "invalid-number"
  | "invalid-address"
  | "invalid-type";

export type ContactRequestProblem =
  | ContactDraftProblem
  | "invalid-contact"
  | "invalid-version"
  | "invalid-cursor"
  | "unbounded-page";

export interface AddressBookNativePlugin {
  status(): Promise<unknown>;
  requestPermissions(): Promise<unknown>;
  list(options: { query: string; limit: number; cursor?: string }): Promise<unknown>;
  create(): Promise<unknown>;
  edit(options: { id: string; lookup: string; revision: string }): Promise<unknown>;
  get(options: { id: string }): Promise<unknown>;
  save(options: ContactDraft & { id?: string; version?: string }): Promise<unknown>;
  remove(options: { id: string; version: string }): Promise<unknown>;
  resolveNames(options: { numbers: string[] }): Promise<unknown>;
}

export interface AddressBookClientOptions {
  install: ContactsInstall;
  plugin: AddressBookNativePlugin;
  journal?: ActionJournalPlugin;
}

export interface AddressBookClient {
  open(): Promise<AddressBookStatus>;
  close(): Promise<void>;
  retire(): Promise<void>;
  state(): Promise<ContactsState>;
  status(): Promise<AddressBookStatus>;
  requestPermissions(): Promise<AddressBookStatus>;
  list(ask: ContactPageAsk): Promise<AddressBookPage>;
  get(id: ContactId, kind?: ReadKind): Promise<ContactDetail>;
  create(): Promise<HandoffOutcome>;
  edit(contact: AddressBookContact): Promise<HandoffOutcome>;
  createContact(draft: ContactDraft): Promise<ContactSaveResult>;
  updateContact(reviewed: ReviewedContact, draft: ContactDraft): Promise<ContactSaveResult>;
  remove(reviewed: ReviewedContact): Promise<ContactRemoveResult>;
}

export interface ContactNamesClient {
  resolve(screen: NameScreen): Promise<readonly ContactName[]>;
  close(surface: NameSurface): Promise<void>;
}
