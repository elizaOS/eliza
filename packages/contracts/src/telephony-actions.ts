/**
 * Owner-approved telephony effects for installs with the native AOSP telephony
 * profile (`./native-telephony.ts`), beyond the dial handoff in
 * `./phone-dial.ts` and the reviewed send in `./sms-send.ts`.
 *
 * `phone.call.v1` places a call. The agent names a number or a contact; the
 * phone resolves a contact inside the owner's profile, shows the exact name and
 * number, and calls Telecom only after the owner's tap on the unlocked phone.
 * `placed` means Telecom accepted the request. No result claims a connected,
 * answered or completed call. An emergency number is never placed for the
 * agent: the phone opens the system dialer instead (`emergency-handoff`).
 *
 * `contacts.write.v1` creates, changes or deletes one address-book contact.
 * The agent names the contact by search text and supplies the new values; the
 * phone finds the row, shows the owner the before and after, and writes only
 * after approval and only if the row is unchanged since it was shown
 * (`stale` otherwise). The agent receives the outcome, never the address book.
 * A phone that also negotiates `contacts.write.v2` accepts `contact_update`
 * with `add` and `remove`: single numbers or email addresses to add or take
 * away while every other value of the contact stays.
 *
 * `contacts.show.v1` opens Contacts on the phone filtered by the agent's
 * search text. The matches are shown to the owner only; the agent learns
 * `shown` or `not-found`.
 *
 * `contacts.read.v1` returns the one contact the owner has open in Contacts,
 * after the owner approves sharing it, like `messages_read_selected`. It never
 * searches or lists the address book.
 *
 * `sms.compose.v1` is a reviewed SMS whose recipient is a contact name. The
 * phone resolves the name, then runs the same native review and journalled
 * send as `sms.send.v1`. Under the same capability, `sms_reply_selected` puts
 * a draft into the text field of the conversation the owner has open. It names
 * no recipient and never sends: the owner edits it and taps Send.
 * A phone that also negotiates `sms.compose.v2` accepts `sms_compose` with a
 * `target`, like `phone_call`: a contact name or an exact number. The phone
 * chooses the SIM, so a number can be texted from any view. With `draft: true`
 * the phone only puts the body into that recipient's conversation text field;
 * it never sends.
 *
 * `messages.read.v1` and `voicemail.read.v1` return what the owner has open in
 * front: the visible tail of one thread, or one voicemail's transcript. They
 * are reads of an owner-selected item, like `notes_read_selected`; they never
 * list threads, enumerate voicemail or run while the phone is locked.
 *
 * `voicemail.delete.v1` deletes the open voicemail after the owner confirms.
 */
import {
  PHONE_DIAL_NUMBER,
  type PhoneDialTarget,
  validateContactLookupQuery,
} from "./phone-dial.ts";

export const PHONE_CALL_CAPABILITY = "phone.call.v1";
export const CONTACT_WRITE_CAPABILITY = "contacts.write.v1";
/** `contact_update` with `add` or `remove`. */
export const CONTACT_UPDATE_VALUES_CAPABILITY = "contacts.write.v2";
export const CONTACT_SHOW_CAPABILITY = "contacts.show.v1";
export const CONTACT_READ_CAPABILITY = "contacts.read.v1";
export const SMS_COMPOSE_CAPABILITY = "sms.compose.v1";
/** `sms_compose` with a `target` (a contact or a number) and the draft-only form. */
export const SMS_COMPOSE_TARGET_CAPABILITY = "sms.compose.v2";
export const MESSAGES_READ_CAPABILITY = "messages.read.v1";
export const VOICEMAIL_READ_CAPABILITY = "voicemail.read.v1";
export const VOICEMAIL_DELETE_CAPABILITY = "voicemail.delete.v1";

export const CONTACT_NAME_MAX = 128;
export const CONTACT_FIELD_MAX = 8;
export const CONTACT_EMAIL_MAX = 254;
/** A shared contact holds at most this many numbers and this many email addresses. */
export const CONTACT_READ_FIELD_MAX = 32;
/** A shared number is the text the phone stores, so it may hold separators. */
export const CONTACT_READ_NUMBER_MAX = 64;
export const SMS_COMPOSE_BODY_MAX = 1600;
export const MESSAGES_READ_MAX = 20;
export const MESSAGES_READ_BODY_MAX = 1600;
export const VOICEMAIL_TRANSCRIPT_MAX = 8000;

function record(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error(`Invalid ${what}`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[], what: string) {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw Error(`Unexpected ${what} fields`);
}
function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  what: string,
): T {
  if (!allowed.includes(value as T)) throw Error(`Invalid ${what}`);
  return value as T;
}
// C0/C1 controls, bidi overrides and lone surrogates never reach a review or a provider write.
const UNSAFE_TEXT =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject control characters.
  /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
// A message body or transcript may contain line breaks and tabs, nothing else from C0/C1.
const UNSAFE_BODY =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject control characters.
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,189}$/;

function target(value: unknown, what: string): PhoneDialTarget {
  const t = record(value, `${what} target`);
  if (t.kind === "number") {
    exact(t, ["kind", "number"], `${what} target`);
    if (typeof t.number !== "string" || !PHONE_DIAL_NUMBER.test(t.number))
      throw Error(`Invalid ${what} number`);
    return { kind: "number", number: t.number };
  }
  if (t.kind === "contact") {
    exact(t, ["kind", "query"], `${what} target`);
    return { kind: "contact", query: validateContactLookupQuery(t.query) };
  }
  throw Error(`Invalid ${what} target`);
}
function name(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.length > CONTACT_NAME_MAX ||
    UNSAFE_TEXT.test(value)
  )
    throw Error("Invalid contact name");
  return value;
}
function numbers(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > CONTACT_FIELD_MAX ||
    value.some((n) => typeof n !== "string" || !PHONE_DIAL_NUMBER.test(n)) ||
    new Set(value).size !== value.length
  )
    throw Error("Invalid contact numbers");
  return [...(value as string[])];
}
function emails(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > CONTACT_FIELD_MAX ||
    value.some(
      (e) =>
        typeof e !== "string" ||
        e.length > CONTACT_EMAIL_MAX ||
        !EMAIL.test(e) ||
        UNSAFE_TEXT.test(e),
    ) ||
    new Set(value).size !== value.length
  )
    throw Error("Invalid contact email addresses");
  return [...(value as string[])];
}

// ---- phone.call.v1 ---------------------------------------------------------

export type PhoneCallOperation = {
  type: "phone_call";
  target: PhoneDialTarget;
};
export type PhoneCallStatus =
  | "placed"
  | "emergency-handoff"
  | "not-found"
  | "busy"
  | "unavailable"
  | "cancelled"
  | "failed";
/**
 * What the phone observed after the owner's approval. `placed`: Telecom
 * accepted the outgoing call. `busy`: another call was in progress, nothing
 * was placed. `not-found`: no contact with a dialable number matched.
 */
export type PhoneCallResult = {
  kind: "phone-call";
  status: PhoneCallStatus;
  /** True when the owner chose or confirmed the number from a contact lookup. */
  contact: boolean;
};
const CALL_STATUS: readonly PhoneCallStatus[] = [
  "placed",
  "emergency-handoff",
  "not-found",
  "busy",
  "unavailable",
  "cancelled",
  "failed",
];

export function isPhoneCall(value: {
  type?: unknown;
}): value is PhoneCallOperation {
  return value.type === "phone_call";
}
/** Exact, closed validation; it rejects rather than normalizes. */
export function validatePhoneCall(value: unknown): PhoneCallOperation {
  const v = record(value, "call");
  exact(v, ["type", "target"], "call");
  if (v.type !== "phone_call") throw Error("Invalid call");
  return { type: "phone_call", target: target(v.target, "call") };
}
export function validatePhoneCallResult(
  operation: PhoneCallOperation,
  value: unknown,
): PhoneCallResult {
  const v = record(value, "call result");
  exact(v, ["kind", "status", "contact"], "call result");
  if (v.kind !== "phone-call" || typeof v.contact !== "boolean")
    throw Error("Invalid call result");
  const status = oneOf(v.status, CALL_STATUS, "call result");
  if (v.contact && operation.target.kind !== "contact")
    throw Error("A number call cannot report a contact choice");
  if (status === "not-found" && operation.target.kind !== "contact")
    throw Error("Only a contact call can find no contact");
  return { kind: "phone-call", status, contact: v.contact };
}
/** `applied` only when Telecom accepted the call or the emergency dialer opened. */
export function phoneCallReceiptOutcome(
  result: PhoneCallResult,
): "applied" | "failed" {
  return result.status === "placed" || result.status === "emergency-handoff"
    ? "applied"
    : "failed";
}
/** Fixed, factual text for a call receipt. It never says a call connected. */
export function phoneCallResultText(result: PhoneCallResult): string {
  switch (result.status) {
    case "placed":
      return "The owner approved and the phone started the call. This does not show whether it was answered.";
    case "emergency-handoff":
      return "That is an emergency number, so the phone opened its own dialer with the number filled in. The owner places that call there.";
    case "not-found":
      return "No contact with a phone number matched on the phone. Nothing was called.";
    case "busy":
      return "Another call was in progress. Nothing was called.";
    case "cancelled":
      return "The owner dismissed the call. Nothing was called.";
    case "unavailable":
      return "This phone cannot place calls right now. Nothing was called.";
    case "failed":
      return "The phone could not start the call. Nothing was called.";
  }
}

// ---- contacts.write.v1 -----------------------------------------------------

export type ContactFields = {
  displayName: string;
  phoneNumbers: string[];
  emailAddresses: string[];
};
export type ContactCreateOperation = {
  type: "contact_create";
  contact: ContactFields;
};
/** Single values of a contact. A field left out is not touched. */
export type ContactValues = {
  phoneNumbers?: string[];
  emailAddresses?: string[];
};
/**
 * At least one of `set`, `add` and `remove`. `set` replaces the named fields
 * whole; a field left out is unchanged. `add` and `remove` need
 * `contacts.write.v2`: the phone takes the `remove` values away, then adds the
 * `add` values, and keeps every other value. A value to add that the contact
 * already has, or a value to remove that it does not have, changes nothing.
 * A field in `set` cannot also be in `add` or `remove`.
 */
export type ContactUpdateOperation = {
  type: "contact_update";
  query: string;
  set?: Partial<ContactFields>;
  add?: ContactValues;
  remove?: ContactValues;
};
export type ContactDeleteOperation = { type: "contact_delete"; query: string };
export type ContactWriteOperation =
  | ContactCreateOperation
  | ContactUpdateOperation
  | ContactDeleteOperation;
export const CONTACT_WRITE_OPERATION_TYPES = [
  "contact_create",
  "contact_update",
  "contact_delete",
] as const;
export type ContactWriteStatus =
  | "saved"
  | "deleted"
  | "not-found"
  | "stale"
  | "unavailable"
  | "cancelled"
  | "failed"
  | "unknown";
export type ContactWriteResult = {
  kind: "contact-write";
  status: ContactWriteStatus;
};
const CONTACT_STATUS: readonly ContactWriteStatus[] = [
  "saved",
  "deleted",
  "not-found",
  "stale",
  "unavailable",
  "cancelled",
  "failed",
  "unknown",
];
const CONTACT_FIELD_KEYS = ["displayName", "phoneNumbers", "emailAddresses"];
const CONTACT_VALUE_KEYS = ["phoneNumbers", "emailAddresses"] as const;

export function isContactWrite(value: {
  type?: unknown;
}): value is ContactWriteOperation {
  return (CONTACT_WRITE_OPERATION_TYPES as readonly unknown[]).includes(
    value.type,
  );
}
function fields(value: unknown): ContactFields {
  const c = record(value, "contact");
  exact(c, CONTACT_FIELD_KEYS, "contact");
  return {
    displayName: name(c.displayName),
    phoneNumbers: numbers(c.phoneNumbers),
    emailAddresses: emails(c.emailAddresses),
  };
}
function values(value: unknown): ContactValues {
  const raw = record(value, "contact change");
  const keys = Object.keys(raw);
  if (
    !keys.length ||
    keys.some((k) => !(CONTACT_VALUE_KEYS as readonly string[]).includes(k))
  )
    throw Error("Invalid contact change");
  const out: ContactValues = {};
  if (Object.hasOwn(raw, "phoneNumbers"))
    out.phoneNumbers = numbers(raw.phoneNumbers);
  if (Object.hasOwn(raw, "emailAddresses"))
    out.emailAddresses = emails(raw.emailAddresses);
  if (CONTACT_VALUE_KEYS.some((k) => out[k]?.length === 0))
    throw Error("Invalid contact change");
  return out;
}
export function validateContactWrite(value: unknown): ContactWriteOperation {
  const v = record(value, "contact change");
  if (v.type === "contact_create") {
    exact(v, ["type", "contact"], "contact change");
    return { type: "contact_create", contact: fields(v.contact) };
  }
  if (v.type === "contact_update") {
    const parts = ["set", "add", "remove"].filter((k) => Object.hasOwn(v, k));
    exact(v, ["type", "query", ...parts], "contact change");
    if (!parts.length) throw Error("Invalid contact change");
    let set: Partial<ContactFields> | undefined;
    if (Object.hasOwn(v, "set")) {
      const raw = record(v.set, "contact change");
      const keys = Object.keys(raw);
      if (!keys.length || keys.some((k) => !CONTACT_FIELD_KEYS.includes(k)))
        throw Error("Invalid contact change");
      set = {};
      if (Object.hasOwn(raw, "displayName"))
        set.displayName = name(raw.displayName);
      if (Object.hasOwn(raw, "phoneNumbers"))
        set.phoneNumbers = numbers(raw.phoneNumbers);
      if (Object.hasOwn(raw, "emailAddresses"))
        set.emailAddresses = emails(raw.emailAddresses);
    }
    const add = Object.hasOwn(v, "add") ? values(v.add) : undefined;
    const remove = Object.hasOwn(v, "remove") ? values(v.remove) : undefined;
    // One field has one meaning in a review: replaced whole, or changed by value.
    for (const k of CONTACT_VALUE_KEYS)
      if (
        (set?.[k] && (add?.[k] || remove?.[k])) ||
        add?.[k]?.some((item) => remove?.[k]?.includes(item))
      )
        throw Error("Invalid contact change");
    return {
      type: "contact_update",
      query: validateContactLookupQuery(v.query),
      ...(set ? { set } : {}),
      ...(add ? { add } : {}),
      ...(remove ? { remove } : {}),
    };
  }
  if (v.type === "contact_delete") {
    exact(v, ["type", "query"], "contact change");
    return {
      type: "contact_delete",
      query: validateContactLookupQuery(v.query),
    };
  }
  throw Error("Invalid contact change");
}
/** `add` and `remove` are never sent to a phone that did not negotiate `contacts.write.v2`. */
export function contactWriteCapabilityAvailable(
  operation: ContactWriteOperation,
  capabilities: readonly string[] | undefined,
): boolean {
  return (
    capabilities?.includes(CONTACT_WRITE_CAPABILITY) === true &&
    (operation.type !== "contact_update" ||
      (!operation.add && !operation.remove) ||
      capabilities.includes(CONTACT_UPDATE_VALUES_CAPABILITY))
  );
}
export function validateContactWriteResult(
  operation: ContactWriteOperation,
  value: unknown,
): ContactWriteResult {
  const v = record(value, "contact result");
  exact(v, ["kind", "status"], "contact result");
  if (v.kind !== "contact-write") throw Error("Invalid contact result");
  const status = oneOf(v.status, CONTACT_STATUS, "contact result");
  if (status === "deleted" && operation.type !== "contact_delete")
    throw Error("Only a delete can report a deleted contact");
  if (status === "saved" && operation.type === "contact_delete")
    throw Error("A delete cannot report a saved contact");
  if (
    (status === "not-found" || status === "stale") &&
    operation.type === "contact_create"
  )
    throw Error("A new contact cannot be missing or changed");
  return { kind: "contact-write", status };
}
export function contactWriteReceiptOutcome(
  result: ContactWriteResult,
): "applied" | "failed" | "unknown" {
  return result.status === "saved" || result.status === "deleted"
    ? "applied"
    : result.status === "unknown"
      ? "unknown"
      : "failed";
}
export function contactWriteResultText(result: ContactWriteResult): string {
  switch (result.status) {
    case "saved":
      return "The owner approved and the contact was saved on the phone.";
    case "deleted":
      return "The owner approved and the contact was deleted from the phone.";
    case "not-found":
      return "No matching contact was found on the phone. Nothing was changed.";
    case "stale":
      return "The contact changed on the phone after it was shown. Nothing was changed.";
    case "cancelled":
      return "The owner dismissed the change. Nothing was changed.";
    case "unavailable":
      return "Contacts cannot be changed on this phone right now. Nothing was changed.";
    case "unknown":
      return "The phone could not confirm whether the contact change completed. It will not be repeated automatically. Check Contacts before trying again.";
    case "failed":
      return "The phone could not save the change. Nothing was changed.";
  }
}

// ---- contacts.show.v1 ------------------------------------------------------

/** Opens Contacts on the phone filtered by `query`. Nothing is returned but the status. */
export type ContactShowOperation = { type: "contact_show"; query: string };
/**
 * `shown`: Contacts is in front with at least one match listed. `not-found`:
 * no contact matched. No name, number or count is included.
 */
export type ContactShowResult = {
  kind: "contact-show";
  status: "shown" | "not-found" | "unavailable";
};
export function isContactShow(value: {
  type?: unknown;
}): value is ContactShowOperation {
  return value.type === "contact_show";
}
export function validateContactShow(value: unknown): ContactShowOperation {
  const v = record(value, "contact search");
  exact(v, ["type", "query"], "contact search");
  if (v.type !== "contact_show") throw Error("Invalid contact search");
  return { type: "contact_show", query: validateContactLookupQuery(v.query) };
}
export function validateContactShowResult(value: unknown): ContactShowResult {
  const v = record(value, "contact search result");
  exact(v, ["kind", "status"], "contact search result");
  if (v.kind !== "contact-show") throw Error("Invalid contact search result");
  return {
    kind: "contact-show",
    status: oneOf(
      v.status,
      ["shown", "not-found", "unavailable"] as const,
      "contact search result",
    ),
  };
}
export function contactShowResultText(result: ContactShowResult): string {
  switch (result.status) {
    case "shown":
      return "Contacts is open on the phone and shows the matching contacts to the owner. No contact detail was shared with you.";
    case "not-found":
      return "No matching contact was found on the phone.";
    case "unavailable":
      return "Contacts cannot be shown on this phone right now.";
  }
}

// ---- contacts.read.v1 ------------------------------------------------------

export type ContactReadOperation = { type: "contact_read_selected" };
/**
 * The contact the owner has open. `displayName` is null for a contact with no
 * name. Numbers are the text the phone stores. Nothing else of the contact,
 * and no other contact, is included.
 */
export type ReadContact = {
  displayName: string | null;
  phoneNumbers: string[];
  emailAddresses: string[];
};
/** `unavailable` also covers an open contact too large to share whole. */
export type ContactReadResult =
  | { kind: "contact-read"; status: "read"; contact: ReadContact }
  | { kind: "contact-read"; status: "none-selected" | "unavailable" };

export function isContactRead(value: {
  type?: unknown;
}): value is ContactReadOperation {
  return value.type === "contact_read_selected";
}
export function validateContactRead(value: unknown): ContactReadOperation {
  const v = record(value, "contact read");
  exact(v, ["type"], "contact read");
  if (v.type !== "contact_read_selected") throw Error("Invalid contact read");
  return { type: "contact_read_selected" };
}
function readValues(value: unknown, max: number): string[] {
  if (
    !Array.isArray(value) ||
    value.length > CONTACT_READ_FIELD_MAX ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        !item ||
        item !== item.trim() ||
        item.length > max ||
        UNSAFE_TEXT.test(item),
    )
  )
    throw Error("Invalid contact read result");
  return [...(value as string[])];
}
export function validateContactReadResult(value: unknown): ContactReadResult {
  const v = record(value, "contact read result");
  if (v.kind !== "contact-read") throw Error("Invalid contact read result");
  if (v.status === "none-selected" || v.status === "unavailable") {
    exact(v, ["kind", "status"], "contact read result");
    return { kind: "contact-read", status: v.status };
  }
  exact(v, ["kind", "status", "contact"], "contact read result");
  if (v.status !== "read") throw Error("Invalid contact read result");
  const c = record(v.contact, "contact read result");
  exact(c, CONTACT_FIELD_KEYS, "contact read result");
  return {
    kind: "contact-read",
    status: "read",
    contact: {
      displayName: c.displayName === null ? null : name(c.displayName),
      phoneNumbers: readValues(c.phoneNumbers, CONTACT_READ_NUMBER_MAX),
      emailAddresses: readValues(c.emailAddresses, CONTACT_EMAIL_MAX),
    },
  };
}

// ---- sms.compose.v1 --------------------------------------------------------

/**
 * A reviewed SMS to one recipient. The `query` form names a contact by search
 * text and needs only `sms.compose.v1`. The `target` form names a contact or
 * an exact number and needs `sms.compose.v2` as well. `draft: true` asks the
 * phone to put the body into that recipient's conversation and send nothing.
 */
export type SmsComposeOperation =
  | { type: "sms_compose"; query: string; body: string }
  | {
      type: "sms_compose";
      target: PhoneDialTarget;
      body: string;
      draft?: true;
    };
export type SmsComposeStatus =
  | "drafted"
  | "submitted"
  | "sent"
  | "delivered"
  | "unknown"
  | "not-found"
  | "unavailable"
  | "cancelled"
  | "failed";
export type SmsComposeResult = {
  kind: "sms-compose";
  status: SmsComposeStatus;
};
const COMPOSE_STATUS: readonly SmsComposeStatus[] = [
  "drafted",
  "submitted",
  "sent",
  "delivered",
  "unknown",
  "not-found",
  "unavailable",
  "cancelled",
  "failed",
];
export function isSmsCompose(value: {
  type?: unknown;
}): value is SmsComposeOperation {
  return value.type === "sms_compose";
}
function body(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > SMS_COMPOSE_BODY_MAX ||
    UNSAFE_BODY.test(value)
  )
    throw Error("Invalid message");
  return value;
}
export function validateSmsCompose(value: unknown): SmsComposeOperation {
  const v = record(value, "message");
  if (v.type !== "sms_compose") throw Error("Invalid message");
  if (!Object.hasOwn(v, "target")) {
    exact(v, ["type", "query", "body"], "message");
    const text = body(v.body);
    return {
      type: "sms_compose",
      query: validateContactLookupQuery(v.query),
      body: text,
    };
  }
  exact(
    v,
    ["type", "target", "body", ...(Object.hasOwn(v, "draft") ? ["draft"] : [])],
    "message",
  );
  if (Object.hasOwn(v, "draft") && typeof v.draft !== "boolean")
    throw Error("Invalid message");
  const text = body(v.body);
  return {
    type: "sms_compose",
    target: target(v.target, "message"),
    body: text,
    ...(v.draft === true ? { draft: true as const } : {}),
  };
}
/** The recipient of either form; a `query` is a contact target. */
export function smsComposeTarget(
  operation: SmsComposeOperation,
): PhoneDialTarget {
  return "target" in operation
    ? operation.target
    : { kind: "contact", query: operation.query };
}
/** The `target` form is never sent to a phone that did not negotiate `sms.compose.v2`. */
export function smsComposeCapabilityAvailable(
  operation: SmsComposeOperation,
  capabilities: readonly string[] | undefined,
): boolean {
  return (
    capabilities?.includes(SMS_COMPOSE_CAPABILITY) === true &&
    (!("target" in operation) ||
      capabilities.includes(SMS_COMPOSE_TARGET_CAPABILITY))
  );
}
export function validateSmsComposeResult(value: unknown): SmsComposeResult {
  const v = record(value, "message result");
  exact(v, ["kind", "status"], "message result");
  if (v.kind !== "sms-compose") throw Error("Invalid message result");
  return {
    kind: "sms-compose",
    status: oneOf(v.status, COMPOSE_STATUS, "message result"),
  };
}
/**
 * `unknown` is not a failure and is never retried: the radio may have taken the
 * message. `drafted`: the body went into the recipient's conversation text
 * field, because that conversation was already open or the request was
 * `draft: true`; nothing was sent.
 */
export function smsComposeReceiptOutcome(
  result: SmsComposeResult,
): "applied" | "failed" | "unknown" {
  if (["drafted", "submitted", "sent", "delivered"].includes(result.status))
    return "applied";
  return result.status === "unknown" ? "unknown" : "failed";
}
export function smsComposeResultText(result: SmsComposeResult): string {
  switch (result.status) {
    case "drafted":
      return "The message is in that conversation's text field for the owner to edit and send. Nothing was sent.";
    case "submitted":
      return "The owner approved and the phone handed the message to the carrier. It is not yet confirmed sent.";
    case "sent":
      return "The owner approved and the carrier accepted the message.";
    case "delivered":
      return "The owner approved and the carrier reported the message delivered.";
    case "unknown":
      return "The phone could not confirm whether the message was sent. It was not sent again.";
    case "not-found":
      return "No contact with a phone number matched on the phone. Nothing was sent.";
    case "cancelled":
      return "The owner dismissed the message. Nothing was sent.";
    case "unavailable":
      return "This phone cannot send messages right now. Nothing was sent.";
    case "failed":
      return "The message was not sent.";
  }
}

/**
 * A draft for the conversation the owner has open in Messages. It names no
 * recipient, so it works for an unknown number or a group, and it never sends.
 */
export type SmsReplyOperation = { type: "sms_reply_selected"; body: string };
export type SmsReplyStatus =
  | "drafted"
  | "none-selected"
  | "occupied"
  | "unavailable";
/**
 * `drafted`: the body is in the open conversation's text field. `occupied`:
 * the field already held the owner's own text, which was left untouched.
 */
export type SmsReplyResult = { kind: "sms-reply"; status: SmsReplyStatus };
const REPLY_STATUS: readonly SmsReplyStatus[] = [
  "drafted",
  "none-selected",
  "occupied",
  "unavailable",
];
export function isSmsReply(value: {
  type?: unknown;
}): value is SmsReplyOperation {
  return value.type === "sms_reply_selected";
}
export function validateSmsReply(value: unknown): SmsReplyOperation {
  const v = record(value, "reply draft");
  exact(v, ["type", "body"], "reply draft");
  if (v.type !== "sms_reply_selected") throw Error("Invalid reply draft");
  return { type: "sms_reply_selected", body: body(v.body) };
}
export function validateSmsReplyResult(value: unknown): SmsReplyResult {
  const v = record(value, "reply draft result");
  exact(v, ["kind", "status"], "reply draft result");
  if (v.kind !== "sms-reply") throw Error("Invalid reply draft result");
  return {
    kind: "sms-reply",
    status: oneOf(v.status, REPLY_STATUS, "reply draft result"),
  };
}
/** A draft is placed or it is not; no outcome is uncertain because nothing is sent. */
export function smsReplyReceiptOutcome(
  result: SmsReplyResult,
): "applied" | "failed" {
  return result.status === "drafted" ? "applied" : "failed";
}
export function smsReplyResultText(result: SmsReplyResult): string {
  switch (result.status) {
    case "drafted":
      return "The draft is in the open conversation's text field for the owner to edit and send. Nothing was sent.";
    case "none-selected":
      return "The owner has no conversation open. Nothing was drafted.";
    case "occupied":
      return "The owner is writing their own message in that conversation. Nothing was changed.";
    case "unavailable":
      return "This phone cannot draft messages right now. Nothing was drafted.";
  }
}

// ---- messages.read.v1 ------------------------------------------------------

export type MessagesReadOperation = { type: "messages_read_selected" };
export type ReadMessage = {
  /** `in`: received; `out`: sent from this phone. */
  direction: "in" | "out";
  /** Epoch milliseconds. */
  date: number;
  body: string;
};
/**
 * The open thread's visible tail, oldest first. `participant` is the name the
 * phone shows for a one-to-one thread and null for a group or unknown sender;
 * no phone number is included.
 */
export type MessagesReadResult =
  | {
      kind: "messages-read";
      status: "read";
      participant: string | null;
      messages: ReadMessage[];
      truncated: boolean;
    }
  | { kind: "messages-read"; status: "none-selected" | "unavailable" };

export function isMessagesRead(value: {
  type?: unknown;
}): value is MessagesReadOperation {
  return value.type === "messages_read_selected";
}
export function validateMessagesRead(value: unknown): MessagesReadOperation {
  const v = record(value, "messages read");
  exact(v, ["type"], "messages read");
  if (v.type !== "messages_read_selected") throw Error("Invalid messages read");
  return { type: "messages_read_selected" };
}
export function validateMessagesReadResult(value: unknown): MessagesReadResult {
  const v = record(value, "messages read result");
  if (v.kind !== "messages-read") throw Error("Invalid messages read result");
  if (v.status === "none-selected" || v.status === "unavailable") {
    exact(v, ["kind", "status"], "messages read result");
    return { kind: "messages-read", status: v.status };
  }
  exact(
    v,
    ["kind", "status", "participant", "messages", "truncated"],
    "messages read result",
  );
  if (
    v.status !== "read" ||
    typeof v.truncated !== "boolean" ||
    !Array.isArray(v.messages) ||
    v.messages.length > MESSAGES_READ_MAX ||
    (v.participant !== null &&
      (typeof v.participant !== "string" ||
        !v.participant ||
        v.participant.length > CONTACT_NAME_MAX ||
        UNSAFE_TEXT.test(v.participant)))
  )
    throw Error("Invalid messages read result");
  let previous = 0;
  const messages = v.messages.map((raw) => {
    const m = record(raw, "read message");
    exact(m, ["direction", "date", "body"], "read message");
    if (
      !Number.isSafeInteger(m.date) ||
      (m.date as number) < previous ||
      typeof m.body !== "string" ||
      m.body.length > MESSAGES_READ_BODY_MAX ||
      UNSAFE_BODY.test(m.body)
    )
      throw Error("Invalid read message");
    previous = m.date as number;
    return {
      direction: oneOf(m.direction, ["in", "out"] as const, "read message"),
      date: m.date as number,
      body: m.body,
    };
  });
  return {
    kind: "messages-read",
    status: "read",
    participant: v.participant as string | null,
    messages,
    truncated: v.truncated,
  };
}

// ---- voicemail.read.v1 / voicemail.delete.v1 -------------------------------

export type VoicemailReadOperation = { type: "voicemail_read_selected" };
export type VoicemailDeleteOperation = { type: "voicemail_delete_selected" };
export type VoicemailTranscriptState =
  | "ready"
  | "pending"
  | "unavailable"
  | "failed";
export type VoicemailTranscriptEngine = "device" | "cloud" | "carrier";
/**
 * The open voicemail. `transcript` is present only when `transcriptState` is
 * `ready`; `engine` names where it was transcribed, following the owner's
 * speech setting. `caller` is the contact name the phone shows, or null.
 */
export type VoicemailReadResult =
  | {
      kind: "voicemail-read";
      status: "read";
      caller: string | null;
      date: number;
      durationSeconds: number;
      transcriptState: VoicemailTranscriptState;
      engine: VoicemailTranscriptEngine | null;
      transcript: string | null;
    }
  | { kind: "voicemail-read"; status: "none-selected" | "unavailable" };
export type VoicemailDeleteResult = {
  kind: "voicemail-delete";
  status: "deleted" | "none-selected" | "unavailable" | "cancelled" | "failed";
};

export function isVoicemailRead(value: {
  type?: unknown;
}): value is VoicemailReadOperation {
  return value.type === "voicemail_read_selected";
}
export function isVoicemailDelete(value: {
  type?: unknown;
}): value is VoicemailDeleteOperation {
  return value.type === "voicemail_delete_selected";
}
export function validateVoicemailRead(value: unknown): VoicemailReadOperation {
  const v = record(value, "voicemail read");
  exact(v, ["type"], "voicemail read");
  if (v.type !== "voicemail_read_selected")
    throw Error("Invalid voicemail read");
  return { type: "voicemail_read_selected" };
}
export function validateVoicemailDelete(
  value: unknown,
): VoicemailDeleteOperation {
  const v = record(value, "voicemail delete");
  exact(v, ["type"], "voicemail delete");
  if (v.type !== "voicemail_delete_selected")
    throw Error("Invalid voicemail delete");
  return { type: "voicemail_delete_selected" };
}
export function validateVoicemailReadResult(
  value: unknown,
): VoicemailReadResult {
  const v = record(value, "voicemail read result");
  if (v.kind !== "voicemail-read") throw Error("Invalid voicemail read result");
  if (v.status === "none-selected" || v.status === "unavailable") {
    exact(v, ["kind", "status"], "voicemail read result");
    return { kind: "voicemail-read", status: v.status };
  }
  exact(
    v,
    [
      "kind",
      "status",
      "caller",
      "date",
      "durationSeconds",
      "transcriptState",
      "engine",
      "transcript",
    ],
    "voicemail read result",
  );
  const transcriptState = oneOf(
    v.transcriptState,
    ["ready", "pending", "unavailable", "failed"] as const,
    "voicemail transcript state",
  );
  if (
    v.status !== "read" ||
    !Number.isSafeInteger(v.date) ||
    !Number.isSafeInteger(v.durationSeconds) ||
    (v.durationSeconds as number) < 0 ||
    (v.caller !== null &&
      (typeof v.caller !== "string" ||
        !v.caller ||
        v.caller.length > CONTACT_NAME_MAX ||
        UNSAFE_TEXT.test(v.caller)))
  )
    throw Error("Invalid voicemail read result");
  const ready = transcriptState === "ready";
  const hasTranscript =
    typeof v.transcript === "string" &&
    v.transcript.length > 0 &&
    v.transcript.length <= VOICEMAIL_TRANSCRIPT_MAX &&
    !UNSAFE_BODY.test(v.transcript);
  const hasEngine =
    v.engine === "device" || v.engine === "cloud" || v.engine === "carrier";
  if (
    ready
      ? !hasTranscript || !hasEngine
      : v.transcript !== null || v.engine !== null
  )
    throw Error("Invalid voicemail transcript");
  return {
    kind: "voicemail-read",
    status: "read",
    caller: v.caller as string | null,
    date: v.date as number,
    durationSeconds: v.durationSeconds as number,
    transcriptState,
    engine: v.engine as VoicemailTranscriptEngine | null,
    transcript: v.transcript as string | null,
  };
}
export function validateVoicemailDeleteResult(
  value: unknown,
): VoicemailDeleteResult {
  const v = record(value, "voicemail delete result");
  exact(v, ["kind", "status"], "voicemail delete result");
  if (v.kind !== "voicemail-delete")
    throw Error("Invalid voicemail delete result");
  return {
    kind: "voicemail-delete",
    status: oneOf(
      v.status,
      [
        "deleted",
        "none-selected",
        "unavailable",
        "cancelled",
        "failed",
      ] as const,
      "voicemail delete result",
    ),
  };
}
export function voicemailDeleteResultText(
  result: VoicemailDeleteResult,
): string {
  switch (result.status) {
    case "deleted":
      return "The owner confirmed and the voicemail was deleted.";
    case "none-selected":
      return "No voicemail is open on the phone. Nothing was deleted.";
    case "cancelled":
      return "The owner kept the voicemail. Nothing was deleted.";
    case "unavailable":
      return "Voicemail is not available on this phone. Nothing was deleted.";
    case "failed":
      return "The voicemail could not be deleted.";
  }
}

export type TelephonyActionOperation =
  | PhoneCallOperation
  | ContactWriteOperation
  | ContactShowOperation
  | ContactReadOperation
  | SmsComposeOperation
  | SmsReplyOperation
  | MessagesReadOperation
  | VoicemailReadOperation
  | VoicemailDeleteOperation;
export const TELEPHONY_ACTION_OPERATION_TYPES = [
  "phone_call",
  ...CONTACT_WRITE_OPERATION_TYPES,
  "contact_show",
  "contact_read_selected",
  "sms_compose",
  "sms_reply_selected",
  "messages_read_selected",
  "voicemail_read_selected",
  "voicemail_delete_selected",
] as const;
export type TelephonyActionType =
  (typeof TELEPHONY_ACTION_OPERATION_TYPES)[number];

/** The single capability each operation type requires. */
export function telephonyActionCapability(type: TelephonyActionType): string {
  switch (type) {
    case "phone_call":
      return PHONE_CALL_CAPABILITY;
    case "contact_create":
    case "contact_update":
    case "contact_delete":
      return CONTACT_WRITE_CAPABILITY;
    case "contact_show":
      return CONTACT_SHOW_CAPABILITY;
    case "contact_read_selected":
      return CONTACT_READ_CAPABILITY;
    case "sms_compose":
    case "sms_reply_selected":
      return SMS_COMPOSE_CAPABILITY;
    case "messages_read_selected":
      return MESSAGES_READ_CAPABILITY;
    case "voicemail_read_selected":
      return VOICEMAIL_READ_CAPABILITY;
    case "voicemail_delete_selected":
      return VOICEMAIL_DELETE_CAPABILITY;
  }
}
export function isTelephonyAction(value: {
  type?: unknown;
}): value is TelephonyActionOperation {
  return (TELEPHONY_ACTION_OPERATION_TYPES as readonly unknown[]).includes(
    value.type,
  );
}
export function validateTelephonyAction(
  value: unknown,
): TelephonyActionOperation {
  const type = record(value, "telephony action").type;
  if (type === "phone_call") return validatePhoneCall(value);
  if (type === "contact_show") return validateContactShow(value);
  if (type === "contact_read_selected") return validateContactRead(value);
  if (type === "sms_compose") return validateSmsCompose(value);
  if (type === "sms_reply_selected") return validateSmsReply(value);
  if (type === "messages_read_selected") return validateMessagesRead(value);
  if (type === "voicemail_read_selected") return validateVoicemailRead(value);
  if (type === "voicemail_delete_selected")
    return validateVoicemailDelete(value);
  return validateContactWrite(value);
}
/**
 * Capabilities a telephony host may advertise for these actions. Without the
 * native profile the answer is empty. Reads and SMS need the SMS role's
 * provider access; voicemail needs a carrier that offers visual voicemail.
 * `contactValues`, `contactsShow` and `contactsRead` are for a host that
 * applies `add` and `remove`, filters its Contacts view, and shares the open
 * contact; a host that leaves them out advertises none of the three.
 */
export function telephonyActionCapabilities(profile: {
  present: boolean;
  call: boolean;
  contactsWrite: boolean;
  sms: boolean;
  voicemail: boolean;
  contactValues?: boolean;
  contactsShow?: boolean;
  contactsRead?: boolean;
}): string[] {
  if (!profile.present) return [];
  return [
    ...(profile.call ? [PHONE_CALL_CAPABILITY] : []),
    ...(profile.contactsWrite ? [CONTACT_WRITE_CAPABILITY] : []),
    ...(profile.contactsWrite && profile.contactValues
      ? [CONTACT_UPDATE_VALUES_CAPABILITY]
      : []),
    ...(profile.contactsShow ? [CONTACT_SHOW_CAPABILITY] : []),
    ...(profile.contactsRead ? [CONTACT_READ_CAPABILITY] : []),
    ...(profile.sms ? [SMS_COMPOSE_CAPABILITY, MESSAGES_READ_CAPABILITY] : []),
    ...(profile.voicemail
      ? [VOICEMAIL_READ_CAPABILITY, VOICEMAIL_DELETE_CAPABILITY]
      : []),
  ];
}
