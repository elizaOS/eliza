/**
 * Renderer contract of the AOSP profile's address book, served by a host subclass of the native
 * `AddressBookPlugin` (`@elizaos/plugin-native-contacts`): bounded same-profile reads while the
 * phone is unlocked with the host in front, the system Contacts editor handoffs (`create`, `edit`),
 * and, for hosts that hold WRITE_CONTACTS, the owner's own saves and removals from the host's
 * screen.
 *
 * An in-app write names the `version` of the contact that was read. A contact that changed since is
 * answered `stale` and nothing is written; the renderer reads it again and the owner decides again.
 * Native results are untrusted until parsed: an unknown shape, an unknown field or an over-bound
 * value is refused, never repaired.
 */

/** Phone type names, in Android's order. A type the owner named is `custom:<label>`. */
export const CONTACT_PHONE_TYPES = [
  "home",
  "mobile",
  "work",
  "fax_work",
  "fax_home",
  "pager",
  "other",
  "callback",
  "car",
  "company_main",
  "isdn",
  "main",
  "other_fax",
  "radio",
  "telex",
  "tty_tdd",
  "work_mobile",
  "work_pager",
  "assistant",
  "mms",
] as const;
/** Email type names, in Android's order. A type the owner named is `custom:<label>`. */
export const CONTACT_EMAIL_TYPES = ["home", "work", "other", "mobile"] as const;
export const CONTACT_CUSTOM_TYPE_PREFIX = "custom:";
export const CONTACT_MAX_FIELDS = 32;
export const CONTACT_MAX_NAME = 256;
export const CONTACT_MAX_NUMBER = 64;
export const CONTACT_MAX_ADDRESS = 320;
export const CONTACT_MAX_LABEL = 64;
/** The largest page `list` returns. */
export const ADDRESS_BOOK_MAX_PAGE = 200;

export interface AddressBookStatus {
  /** The host's profile admits this install. */
  available: boolean;
  /** Contacts can be read now: admitted, unlocked, in front and READ_CONTACTS granted. */
  readable: boolean;
  /** In-app saves and removals are permitted now (readable and WRITE_CONTACTS granted). */
  writable: boolean;
}
/** One listed contact. `revision` is what `edit` (the system editor handoff) rechecks. */
export interface AddressBookContact {
  id: string;
  lookup: string;
  name: string;
  revision: string | null;
  starred: boolean;
  phones: string[];
  emails: string[];
}
export type AddressBookIncompleteReason = "field-too-long" | "too-many-fields";
/** A contact the host refused to clip. It carries no content; open it in the system Contacts app. */
export interface IncompleteAddressBookContact {
  id: string;
  incomplete: true;
  reason: AddressBookIncompleteReason;
}
export interface AddressBookPage {
  contacts: (AddressBookContact | IncompleteAddressBookContact)[];
  /** Pass back with the same query to read the following page; null on the last page. */
  next: string | null;
}
export interface ContactPhone {
  number: string;
  /** One of `CONTACT_PHONE_TYPES`, or `custom:<label>`. */
  type: string;
}
export interface ContactEmail {
  address: string;
  /** One of `CONTACT_EMAIL_TYPES`, or `custom:<label>`. */
  type: string;
}
/** One contact read for editing in the host's own screen. */
export interface ContactDetail {
  id: string;
  lookup: string;
  displayName: string;
  starred: boolean;
  phoneNumbers: ContactPhone[];
  emailAddresses: ContactEmail[];
  /** Opaque; changes whenever the contact's data or its merged raw contacts change. */
  version: string;
}
/** What the owner saves. Nothing is trimmed or reordered on the way to the phone. */
export interface ContactDraft {
  displayName: string;
  phoneNumbers: ContactPhone[];
  emailAddresses: ContactEmail[];
}
/**
 * `saved`: written. `id` and `version` are null only if the saved contact could not be read back;
 * read the list again then. `stale`: the contact changed after it was read; nothing was written.
 * `not-found`: the contact is gone. `failed`: Android refused the write; nothing was written.
 * `unknown`: the provider did not confirm the write; refresh before deciding whether to try again.
 */
export type ContactSaveResult =
  | { status: "saved"; id: string | null; version: string | null }
  | { status: "stale" | "not-found" | "failed" | "unknown" };
export type ContactRemoveResult = {
  status: "deleted" | "stale" | "not-found" | "failed" | "unknown";
};
export type ContactDraftProblem =
  | "empty-contact"
  | "invalid-name"
  | "too-many-fields"
  | "invalid-number"
  | "invalid-address"
  | "invalid-type";

/** The native bridge surface of a host's `AddressBookPlugin` subclass. Results are untrusted until
 * parsed. The in-app methods reject with a `code`: `unavailable`, `permission-required` (no
 * WRITE_CONTACTS), `not-found`, `incomplete` (more than the editor reads) or `invalid`. */
export interface AddressBookNativePlugin {
  status(): Promise<unknown>;
  requestPermissions(): Promise<unknown>;
  list(options: {
    query: string;
    limit: number;
    cursor?: string;
  }): Promise<unknown>;
  create(): Promise<unknown>;
  edit(options: {
    id: string;
    lookup: string;
    revision: string;
  }): Promise<unknown>;
  get?(options: { id: string }): Promise<unknown>;
  save?(
    options: ContactDraft & { id?: string; version?: string },
  ): Promise<unknown>;
  remove?(options: { id: string; version: string }): Promise<unknown>;
}

export class AddressBookUnavailable extends Error {
  readonly name = "AddressBookUnavailable";
  constructor(
    message = "Contacts is available only on the phone's system image.",
  ) {
    super(message);
  }
}

const invalid = (what: string) =>
  new Error(`Contacts returned an invalid ${what}`);
const object = (value: unknown, what: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid(what);
  return value as Record<string, unknown>;
};
const exact = (
  data: Record<string, unknown>,
  keys: readonly string[],
  what: string,
) => {
  if (
    Object.keys(data).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(data, key))
  )
    throw invalid(what);
};
const bool = (value: unknown, what: string) => {
  if (typeof value !== "boolean") throw invalid(what);
  return value;
};
const text = (value: unknown, what: string, max: number) => {
  if (typeof value !== "string" || value.length > max) throw invalid(what);
  return value;
};
const CONTACT_ID = /^[1-9]\d{0,17}$/;
const VERSION = /^[0-9a-f]{64}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** Non-blank, within the bound and free of control characters: what the native editor stores. */
const clean = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length <= max &&
  value.trim() !== "" &&
  !CONTROL.test(value);
const knownType = (value: unknown, names: readonly string[]) =>
  typeof value === "string" &&
  (names.includes(value) ||
    (value.startsWith(CONTACT_CUSTOM_TYPE_PREFIX) &&
      clean(
        value.slice(CONTACT_CUSTOM_TYPE_PREFIX.length),
        CONTACT_MAX_LABEL,
      )));

export function parseAddressBookStatus(value: unknown): AddressBookStatus {
  const data = object(value, "status");
  const available = bool(data.available, "status");
  const readable = bool(data.readable, "status");
  // Hosts older than the in-app editor report no `writable`; they cannot write.
  const writable =
    data.writable === undefined ? false : bool(data.writable, "status");
  if ((readable && !available) || (writable && !readable))
    throw invalid("status");
  return { available, readable, writable };
}

const INCOMPLETE: readonly AddressBookIncompleteReason[] = [
  "field-too-long",
  "too-many-fields",
];
/** Parses one list page. A longer page than requested, a repeated ID, an over-bound field or a
 * continuation without rows is refused. */
export function parseAddressBookPage(
  value: unknown,
  limit: number,
): AddressBookPage {
  const data = object(value, "contact page");
  if (!Array.isArray(data.contacts) || data.contacts.length > limit)
    throw invalid("contact page");
  const more = bool(data.more, "contact page");
  const next = data.next === undefined || data.next === null ? null : data.next;
  if (
    (next === null) === more ||
    (next !== null && (typeof next !== "string" || next.length > 1024)) ||
    (more && !data.contacts.length)
  )
    throw invalid("contact cursor");
  const seen = new Set<string>();
  const values = (list: unknown, what: string) => {
    if (!Array.isArray(list) || list.length > CONTACT_MAX_FIELDS)
      throw invalid(what);
    return list.map((item) => text(item, what, 1024));
  };
  const contacts = data.contacts.map((row) => {
    const c = object(row, "contact");
    const id = text(c.id, "contact id", 18);
    if (!CONTACT_ID.test(id) || seen.has(id)) throw invalid("contact id");
    seen.add(id);
    if (c.incomplete !== undefined) {
      exact(c, ["id", "incomplete", "reason"], "incomplete contact");
      if (
        c.incomplete !== true ||
        !INCOMPLETE.includes(c.reason as AddressBookIncompleteReason)
      )
        throw invalid("incomplete contact");
      return {
        id,
        incomplete: true as const,
        reason: c.reason as AddressBookIncompleteReason,
      };
    }
    return {
      id,
      lookup: text(c.lookup, "contact lookup key", 1024),
      name: text(c.name, "contact name", 1024),
      revision:
        c.revision === undefined || c.revision === null
          ? null
          : text(c.revision, "contact revision", 32),
      starred: bool(c.starred, "contact"),
      phones: values(c.phones, "contact numbers"),
      emails: values(c.emails, "contact emails"),
    };
  });
  return { contacts, next: next as string | null };
}
export function isIncompleteAddressBookContact(
  row: AddressBookContact | IncompleteAddressBookContact,
): row is IncompleteAddressBookContact {
  return "incomplete" in row && row.incomplete === true;
}

function fields<K extends "number" | "address">(
  value: unknown,
  key: K,
  max: number,
  types: readonly string[],
): ({ type: string } & Record<K, string>)[] {
  if (!Array.isArray(value) || value.length > CONTACT_MAX_FIELDS)
    throw invalid(`contact ${key} list`);
  return value.map((raw) => {
    const item = object(raw, `contact ${key}`);
    exact(item, [key, "type"], `contact ${key}`);
    if (!clean(item[key], max) || !knownType(item.type, types))
      throw invalid(`contact ${key}`);
    return { [key]: item[key], type: item.type } as { type: string } & Record<
      K,
      string
    >;
  });
}
/** Parses one contact read for editing: the requested contact, typed fields and a version. */
export function parseContactDetail(value: unknown, id: string): ContactDetail {
  const data = object(value, "contact");
  exact(
    data,
    [
      "id",
      "lookup",
      "displayName",
      "starred",
      "phoneNumbers",
      "emailAddresses",
      "version",
    ],
    "contact",
  );
  if (data.id !== id || !CONTACT_ID.test(id)) throw invalid("contact id");
  const version = text(data.version, "contact version", 64);
  if (!VERSION.test(version)) throw invalid("contact version");
  return {
    id,
    lookup: text(data.lookup, "contact lookup key", 1024),
    displayName: text(data.displayName, "contact name", CONTACT_MAX_NAME),
    starred: bool(data.starred, "contact"),
    phoneNumbers: fields(
      data.phoneNumbers,
      "number",
      CONTACT_MAX_NUMBER,
      CONTACT_PHONE_TYPES,
    ),
    emailAddresses: fields(
      data.emailAddresses,
      "address",
      CONTACT_MAX_ADDRESS,
      CONTACT_EMAIL_TYPES,
    ),
    version,
  };
}

/** Why the native editor would refuse this draft, or null. The draft is checked as given. */
export function contactDraftProblem(
  draft: ContactDraft,
): ContactDraftProblem | null {
  if (
    typeof draft.displayName !== "string" ||
    (draft.displayName !== "" && !clean(draft.displayName, CONTACT_MAX_NAME))
  )
    return "invalid-name";
  if (
    !Array.isArray(draft.phoneNumbers) ||
    !Array.isArray(draft.emailAddresses) ||
    draft.phoneNumbers.length > CONTACT_MAX_FIELDS ||
    draft.emailAddresses.length > CONTACT_MAX_FIELDS
  )
    return "too-many-fields";
  for (const phone of draft.phoneNumbers) {
    if (!clean(phone?.number, CONTACT_MAX_NUMBER)) return "invalid-number";
    if (!knownType(phone.type, CONTACT_PHONE_TYPES)) return "invalid-type";
  }
  for (const email of draft.emailAddresses) {
    if (!clean(email?.address, CONTACT_MAX_ADDRESS)) return "invalid-address";
    if (!knownType(email.type, CONTACT_EMAIL_TYPES)) return "invalid-type";
  }
  if (
    draft.displayName === "" &&
    !draft.phoneNumbers.length &&
    !draft.emailAddresses.length
  )
    return "empty-contact";
  return null;
}

/** Parses a save result. `id` is the contact that was updated; leave it out for a new contact,
 * which has no earlier version to be stale against and cannot be missing. */
export function parseContactSave(
  value: unknown,
  id?: string,
): ContactSaveResult {
  const data = object(value, "contact save");
  if (data.status === "saved") {
    exact(data, ["status", "id", "version"], "contact save");
    const saved = data.id === null ? null : text(data.id, "contact id", 18);
    const version =
      data.version === null ? null : text(data.version, "contact version", 64);
    if (
      (saved === null) !== (version === null) ||
      (saved !== null && !CONTACT_ID.test(saved)) ||
      (version !== null && !VERSION.test(version))
    )
      throw invalid("contact save");
    return { status: "saved", id: saved, version };
  }
  exact(data, ["status"], "contact save");
  if (
    data.status !== "failed" &&
    data.status !== "unknown" &&
    (id === undefined ||
      (data.status !== "stale" && data.status !== "not-found"))
  )
    throw invalid("contact save");
  return {
    status: data.status as "stale" | "not-found" | "failed" | "unknown",
  };
}
const REMOVED = ["deleted", "stale", "not-found", "failed", "unknown"] as const;
export function parseContactRemove(value: unknown): ContactRemoveResult {
  const data = object(value, "contact removal");
  exact(data, ["status"], "contact removal");
  if (!REMOVED.includes(data.status as (typeof REMOVED)[number]))
    throw invalid("contact removal");
  return { status: data.status as ContactRemoveResult["status"] };
}

/** The renderer client. Without a plugin every method rejects without reaching native code. */
export function createAddressBookClient(
  plugin: AddressBookNativePlugin | null,
  options: { unavailableMessage?: string } = {},
) {
  const native = () => {
    if (!plugin) throw new AddressBookUnavailable(options.unavailableMessage);
    return plugin;
  };
  /** The bridge of a host whose native side has the in-app editor; older hosts have none. */
  const editor = () => {
    const bridge = native();
    if (!bridge.get || !bridge.save || !bridge.remove)
      throw new AddressBookUnavailable(
        "Editing contacts here is not available in this install.",
      );
    return bridge as Required<AddressBookNativePlugin>;
  };
  const selected = (id: string, version?: string) => {
    if (typeof id !== "string" || !CONTACT_ID.test(id))
      throw new RangeError("Invalid contact");
    if (
      version !== undefined &&
      (typeof version !== "string" || !VERSION.test(version))
    )
      throw new RangeError("Invalid contact version");
  };
  return {
    available: !!plugin,
    async status() {
      return parseAddressBookStatus(await native().status());
    },
    /** Asks for Contacts access in Android's own dialog, then reads the status again. */
    async requestPermissions() {
      return parseAddressBookStatus(await native().requestPermissions());
    },
    /** One bounded page. `cursor` is the previous page's `next`, with the same query. */
    async list(query: string, limit = 50, cursor?: string) {
      const bridge = native();
      if (
        typeof query !== "string" ||
        query.length > 128 ||
        query.includes("\0")
      )
        throw new RangeError("Contact search must be at most 128 characters");
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > ADDRESS_BOOK_MAX_PAGE
      )
        throw new RangeError("Contact page limit must be 1 to 200");
      if (cursor !== undefined && (typeof cursor !== "string" || !cursor))
        throw new RangeError("Invalid contact cursor");
      return parseAddressBookPage(
        await bridge.list(
          cursor === undefined ? { query, limit } : { query, limit, cursor },
        ),
        limit,
      );
    },
    /** Opens the system Contacts editor for a new contact. Whether anything was saved is not known. */
    async create() {
      await native().create();
    },
    /** Opens the system Contacts editor for a listed contact. Whether anything was saved is not known. */
    async edit(contact: AddressBookContact) {
      const bridge = native();
      selected(contact.id);
      if (contact.revision === null)
        throw new RangeError("This contact has no revision to edit from");
      await bridge.edit({
        id: contact.id,
        lookup: contact.lookup,
        revision: contact.revision,
      });
    },
    /** One contact with typed fields and the `version` an in-app save or removal must name. */
    async get(id: string) {
      const bridge = editor();
      selected(id);
      return parseContactDetail(await bridge.get({ id }), id);
    },
    /** Creates a contact in the phone's local account from the owner's draft. */
    async createContact(draft: ContactDraft) {
      const bridge = editor();
      const problem = contactDraftProblem(draft);
      if (problem) throw new RangeError(`Invalid contact: ${problem}`);
      return parseContactSave(
        await bridge.save({
          displayName: draft.displayName,
          phoneNumbers: draft.phoneNumbers.map(({ number, type }) => ({
            number,
            type,
          })),
          emailAddresses: draft.emailAddresses.map(({ address, type }) => ({
            address,
            type,
          })),
        }),
      );
    },
    /** Applies the owner's edit to the contact read at `version`; `stale` when it changed since. */
    async updateContact(id: string, version: string, draft: ContactDraft) {
      const bridge = editor();
      selected(id, version);
      const problem = contactDraftProblem(draft);
      if (problem) throw new RangeError(`Invalid contact: ${problem}`);
      return parseContactSave(
        await bridge.save({
          id,
          version,
          displayName: draft.displayName,
          phoneNumbers: draft.phoneNumbers.map(({ number, type }) => ({
            number,
            type,
          })),
          emailAddresses: draft.emailAddresses.map(({ address, type }) => ({
            address,
            type,
          })),
        }),
        id,
      );
    },
    /** Deletes the contact the owner chose, read at `version`; `stale` when it changed since. */
    async remove(id: string, version: string) {
      const bridge = editor();
      selected(id, version);
      return parseContactRemove(await bridge.remove({ id, version }));
    },
  };
}
export type AddressBookClient = ReturnType<typeof createAddressBookClient>;
