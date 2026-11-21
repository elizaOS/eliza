/**
 * The recipient of a call, dial, text or keypad prefill is the one the owner
 * wrote in the current message, never one the model chose.
 *
 * The planner sees the owner's number only as a contact reference
 * (`__ELIZA_CONTACT_…__`) that the execution boundary restores. A model that
 * writes digits instead of copying the reference invents a number: on a
 * Pixel (v612) "call 415-555-0100" produced a reviewed call to 6505715862,
 * which appears in no prompt, contact, call log or memory. These checks run
 * before a proposal is persisted, so such a number never reaches review.
 */

import { spokenPhoneNumbers } from "@elizaos/contracts/telephony-actions";
import type { DeviceOperation } from "./contract.ts";
import { phoneDialNumber } from "./phone-dial-contract.ts";
import {
  type AuthoredTelephonyTarget,
  authoredTelephonyTarget,
  emergencyServicesRequest,
  namesEmergencyService,
} from "./telephony-request.ts";

/** Why a recipient was refused before persistence. Never a human review decision. */
export type TelephonyTargetRefusal =
  /** A number the owner did not write in this message. */
  | "number"
  /** A contact name the owner did not write in this message. */
  | "contact"
  /** The owner's recipient does not fit a form this phone negotiated. */
  | "form"
  /**
   * The owner wrote a number, but not as one dial number ("415-555 0100",
   * "415/555/0100"): they are asked to type it again, never told they did
   * not write it.
   */
  | "unreadable"
  /**
   * The owner asked for emergency services and this phone cannot open its
   * keypad: they are told to dial their local emergency number themselves.
   */
  | "emergency";

/**
 * A number the owner wrote in this message that reached the planner only as a
 * secret-swap contact reference (`__ELIZA_CONTACT_<session>_<n>__`).
 */
export type SwappedPhoneReference = {
  readonly placeholder: string;
  /** The owner's number in dial form. */
  readonly number: string;
};

const CONTACT_REFERENCE_PREFIX = "__ELIZA_CONTACT_";

/**
 * The owner's numbers in `text` that this turn's secret-swap session replaced
 * with contact references. The planner never saw their digits, so the only
 * way it can name one is by copying its reference, which the execution
 * boundary restores; any digits it writes for one are invented.
 */
export function swappedPhoneReferences(
  entries:
    | readonly { placeholder: string; value: string; kind: string }[]
    | undefined,
  text: string,
): SwappedPhoneReference[] {
  if (!entries?.length) return [];
  const written = writtenPhoneNumbers(text);
  const references: SwappedPhoneReference[] = [];
  for (const entry of entries) {
    if (
      entry.kind !== "phone" ||
      !entry.placeholder.startsWith(CONTACT_REFERENCE_PREFIX)
    )
      continue;
    const number = dialForms(entry.value)[0];
    if (number && written.some((owned) => samePhoneNumber(owned, number)))
      references.push({ placeholder: entry.placeholder, number });
  }
  return references;
}

/** Policy refusal before persistence; never represents a human review decision. */
export class DeviceTelephonyTargetNotRequestedError extends Error {
  readonly code = "DEVICE_TELEPHONY_TARGET_NOT_REQUESTED";
  /**
   * @param references The owner's swapped numbers: a refused number then
   * tells the model which reference to copy in place of its invented digits.
   */
  constructor(
    readonly refusal: TelephonyTargetRefusal,
    readonly references: readonly string[] = [],
  ) {
    super(
      refusal === "emergency"
        ? "The owner asked for emergency services, and this phone cannot open its keypad. No proposal was created; nothing was called. Tell the owner to dial their local emergency number on the phone's own dialer now."
        : refusal === "unreadable"
          ? "The owner wrote a phone number this request cannot read as one dial number (mixed or unusual separators). No proposal was created; nothing was called or sent. Ask the owner to type the number again with digits only."
          : refusal === "form"
            ? "This phone cannot take the recipient the owner wrote in this form. No proposal was created; nothing was called or sent."
            : refusal === "contact"
              ? "The current original request does not name this contact. Use only the name the owner wrote in this message. No proposal was created; nothing was called or sent."
              : references.length > 0
                ? `The current original request does not contain this phone number. The owner's number reaches you only as a contact reference, so digits you write for it are invented. Copy ${references.length === 1 ? "this reference" : "one of these references"} verbatim as the number, every character and underscore (a country code such as +1 before it is allowed): ${references.join(", ")}. No proposal was created; nothing was called or sent.`
                : "The current original request does not contain this phone number. Use only a number the owner wrote in this message, by copying its contact reference exactly. No proposal was created; nothing was called or sent.",
    );
  }
}

/** What the owner is told to do for an emergency: the keypad opens empty. */
export const EMERGENCY_KEYPAD_REPLY =
  "Opening the keypad. Dial your local emergency number (911 in the US and Canada, 112 in most of Europe) and tap Call.";

/**
 * The reply the owner sees for a refusal: true whichever recipient was
 * refused. With the owner's `text`, a refused number is described as missing
 * only when the message writes or speaks no number at all. A refused contact
 * change (`operationType`) saves a number rather than calling it.
 */
export function telephonyTargetRefusalReply(
  refusal: TelephonyTargetRefusal,
  text?: string,
  operationType?: unknown,
): string {
  const contactChange =
    operationType === "contact_create" || operationType === "contact_update";
  if (refusal === "emergency")
    return "I can't open the keypad on this phone. For an emergency, dial your local emergency number (911 in the US and Canada, 112 in most of Europe) on your phone's dialer now.";
  if (refusal === "unreadable")
    return contactChange
      ? "I couldn't read that as one phone number, so I didn't save it. Nothing was saved. Type the number again with digits only, like 4155550100."
      : "I couldn't read that as one phone number, so I didn't set it up. Nothing was called or sent. Type the number again with digits only, like 4155550100.";
  if (refusal === "number" && contactChange)
    return "I didn't save that, because that number isn't one you wrote in your message. Nothing was saved. Tell me the number to use.";
  if (
    refusal === "number" &&
    text !== undefined &&
    !/\d/.test(text) &&
    spokenPhoneNumbers(text).length === 0
  )
    return "I didn't set that up, because your message doesn't include a phone number. Nothing was called or sent. Tell me the number to use, or the name saved in Contacts.";
  if (refusal === "form")
    return "I can't set that up on this phone with that recipient. Tell me the number to use.";
  if (refusal === "contact")
    return "I didn't set that up, because that name isn't one you wrote in your message. Nothing was called or sent. Tell me who, by their name as saved in Contacts or their number.";
  return "I didn't set that up, because that number isn't one you wrote in your message. Nothing was called or sent. Tell me the number to use.";
}

const CONTACT_NUMBER_PARTS = ["set", "add", "remove"] as const;

/**
 * The phone numbers a contact change writes, adds or removes. A number saved
 * under a contact's name becomes the recipient of every later "call Bob" and
 * "text Bob", so it is grounded like a call's recipient.
 */
function contactNumbers(value: { type?: unknown }): string[] {
  const operation = value as { type?: unknown; [key: string]: unknown };
  const lists: unknown[] = [];
  if (operation.type === "contact_create")
    lists.push((operation.contact as { phoneNumbers?: unknown })?.phoneNumbers);
  if (operation.type === "contact_update")
    for (const part of CONTACT_NUMBER_PARTS)
      lists.push(
        (operation[part] as { phoneNumbers?: unknown } | undefined)
          ?.phoneNumbers,
      );
  return lists.flatMap((list) =>
    Array.isArray(list)
      ? list.filter((item): item is string => typeof item === "string")
      : [],
  );
}

/**
 * Operations whose recipient or prefill is a phone number or contact, and
 * contact changes that write a phone number.
 */
export function namesTelephonyTarget(operation: { type?: unknown }): boolean {
  return (
    operation.type === "phone_call" ||
    operation.type === "phone_dial" ||
    operation.type === "sms_compose" ||
    operation.type === "sms_send" ||
    operation.type === "phone_keypad" ||
    contactNumbers(operation).length > 0
  );
}

// A run of digits as a person writes a number: digit groups joined by spaces,
// dashes, dots and brackets, with an optional leading +.
const WRITTEN_NUMBER =
  /(?<![\p{L}\p{N}+])\+?(?:\(\d+\)|\d)[\d ().-]*\d(?![\p{L}\p{N}])/gu;
// Shorter runs are times, counts and list numbers; 3 keeps 911, 112 and 999.
const MIN_DIGITS = 3;

function dialForms(written: string): string[] {
  try {
    return [phoneDialNumber(written)];
  } catch {
    // "415 555 0100 or 415 302 4399" reads as two numbers, not one.
    return written.split(/\s+/).flatMap((part) => {
      try {
        return [phoneDialNumber(part)];
      } catch {
        return [];
      }
    });
  }
}

/** Every number the text writes, in dial form ("(415) 555-0100" → "4155550100"). */
export function writtenPhoneNumbers(text: string): string[] {
  const numbers = new Set<string>();
  for (const [written] of text.matchAll(WRITTEN_NUMBER))
    for (const number of dialForms(written.trim()))
      if (number.replace("+", "").length >= MIN_DIGITS) numbers.add(number);
  return [...numbers];
}

/**
 * Every number the owner wrote or spoke in `text`: the written numbers, then
 * the digits of a spoken one ("four one five, five five five, oh one double
 * oh" → "4155550100"), which a proposal must equal exactly.
 */
export function ownerPhoneNumbers(text: string): string[] {
  return ownerPhoneNumberTiers(text).flat();
}

/** The owner's written numbers, then the spoken ones that are not also written. */
function ownerPhoneNumberTiers(text: string): OwnedNumbers {
  const written = writtenPhoneNumbers(text);
  return [
    written,
    spokenPhoneNumbers(text).filter((number) => !written.includes(number)),
  ];
}

/**
 * The owner's numbers in the order a proposal is matched against them: the
 * numbers they wrote, then the ones only read as spoken. "to 415-555-0100"
 * also reads as a spoken "24155550100", which must not make the written
 * number ambiguous to a proposal with a country code.
 */
type OwnedNumbers = readonly [written: string[], spoken: string[]];

/**
 * The same number with or without a country code: equal digits, or the same
 * last ten digits when both have at least ten ("+14155550100", "4155550100").
 */
export function samePhoneNumber(a: string, b: string): boolean {
  const x = a.replace("+", ""),
    y = b.replace("+", "");
  return (
    x === y ||
    (x.length >= 10 && y.length >= 10 && x.slice(-10) === y.slice(-10))
  );
}

function normalizedWords(text: string): string {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      // "Maya's cell" names Maya.
      .replace(/'s(?![\p{L}\p{N}])/gu, "")
      .replace(/[^\p{L}\p{N}']+/gu, " ")
      .trim()
  );
}

// Words every request has: a contact query made only of these ("the", "me",
// "call", "her number") names nobody, even though the owner wrote the words.
const NOT_A_NAME = new Set(
  (
    "a an the this that these those it its me my mine myself i you your yours " +
    "he him his she her hers we us our ours they them their someone somebody " +
    "anyone anybody everyone back up now please thanks thank and or to for " +
    "of at on in with from about call ring phone dial text sms message send " +
    "tell ask say saying number cell mobile contact"
  ).split(" "),
);

/** The name, as whole words, appears in the owner's text (case and punctuation aside). */
export function writesContactName(text: string, name: string): boolean {
  const query = normalizedWords(name);
  if (!query || /^[\d\s+]+$/.test(query)) return false;
  if (query.split(" ").every((word) => NOT_A_NAME.has(word))) return false;
  return ` ${normalizedWords(text)} `.includes(` ${query} `);
}

/**
 * Whether a send proposal goes to exactly the recipient of the owner's own
 * addressing clause: the same contact name or the same number. "Write a text
 * to Mom saying Dad is home and send it" never sends to Dad.
 */
export function proposesRequestedRecipient(
  operation: DeviceOperation,
  requested:
    | { kind: "contact"; query: string }
    | { kind: "number"; number: string },
): boolean {
  if (operation.type === "sms_send")
    return (
      requested.kind === "number" &&
      operation.recipients.length === 1 &&
      samePhoneNumber(operation.recipients[0] ?? "", requested.number)
    );
  if (operation.type !== "sms_compose") return false;
  const target =
    "target" in operation
      ? operation.target
      : { kind: "contact" as const, query: operation.query };
  if (target.kind === "number")
    return (
      requested.kind === "number" &&
      samePhoneNumber(target.number, requested.number)
    );
  return (
    requested.kind === "contact" &&
    writesContactName(requested.query, target.query) &&
    writesContactName(target.query, requested.query)
  );
}

const WORD_CHARACTER = /[\p{L}\p{N}]/u;

/**
 * Where `body` occurs in `text` as whole words: a body that starts or ends
 * with a letter or digit never matches inside a longer word or number, so the
 * body "hi" is not the "hi" in "Phil" and "55" is not the "55" in "555".
 */
function bodyOccurrences(text: string, body: string): number[] {
  const haystack = text.toLowerCase(),
    needle = body.toLowerCase();
  const bounded = (at: number) =>
    !(
      WORD_CHARACTER.test(needle[0] ?? "") &&
      WORD_CHARACTER.test(haystack[at - 1] ?? "")
    ) &&
    !(
      WORD_CHARACTER.test(needle.at(-1) ?? "") &&
      WORD_CHARACTER.test(haystack[at + needle.length] ?? "")
    );
  const found: number[] = [];
  for (
    let at = haystack.indexOf(needle);
    at >= 0;
    at = haystack.indexOf(needle, at + 1)
  )
    if (bounded(at)) found.push(at);
  return found;
}

/**
 * The owner's text without the message body they asked to send, so that "text
 * Sam saying call me at 415-555-0100" never makes that number the recipient.
 *
 * The body is cut where it occurs as whole words, preferring the last such
 * occurrence (a body follows its recipient) and never one whose cut would
 * take away the proposed recipient (`keeps`), so "text Phil hi" still names
 * Phil. When every occurrence would, the last is cut and the recipient is
 * refused.
 */
function textWithoutBody(
  text: string,
  body: unknown,
  keeps: (rest: string) => boolean = () => true,
): { text: string; bodyNumbers: string[] } {
  if (typeof body !== "string" || !body.trim())
    return { text, bodyNumbers: [] };
  const trimmed = body.trim();
  const cut = (at: number) =>
    text.slice(0, at) + " " + text.slice(at + trimmed.length);
  const occurrences = bodyOccurrences(text, trimmed);
  if (occurrences.length > 0) {
    const cuts = occurrences.map(cut).reverse();
    return {
      text: cuts.find((rest) => keeps(rest)) ?? cuts[0],
      bodyNumbers: [],
    };
  }
  // The model reworded the body: no number it carries can be the recipient.
  return { text, bodyNumbers: ownerPhoneNumbers(body) };
}

function ownerNumber(
  proposed: string,
  owned: OwnedNumbers,
): string | undefined {
  // The owner's own dial form, never the model's spelling of it. A number the
  // owner wrote is matched before one only read as spoken.
  const digits = proposed.replace("+", "");
  for (const tier of owned) {
    const exact = tier.find((number) => number.replace("+", "") === digits);
    if (exact) return exact;
    const matches = tier.filter((number) => samePhoneNumber(number, proposed));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return undefined;
  }
  return undefined;
}

function recipientNumbers(
  text: string,
  body: unknown,
  proposed?: string,
): OwnedNumbers {
  const numbersIn = (rest: string, bodyNumbers: readonly string[]) =>
    ownerPhoneNumberTiers(rest).map((tier) =>
      tier.filter(
        (number) =>
          !bodyNumbers.some((inBody) => samePhoneNumber(inBody, number)),
      ),
    ) as unknown as OwnedNumbers;
  const { text: rest, bodyNumbers } = textWithoutBody(
    text,
    body,
    (candidate) =>
      proposed === undefined ||
      ownerNumber(proposed, numbersIn(candidate, [])) !== undefined,
  );
  return numbersIn(rest, bodyNumbers);
}

// Digits joined by any separators a person might type, slashes included.
const NUMBER_SHAPED =
  /(?<![\p{L}\p{N}+])\+?[\d(][\d\s()./-]*\d(?![\p{L}\p{N}])/gu;

/**
 * Whether `text` writes `number`'s digits (7 to 15 of them) in a form that is
 * not one dial number: "415-555 0100", "415 - 555 - 0100", "415/555/0100".
 * Only the proposed number's own digits count, so a date or an order number
 * elsewhere in the message never does.
 */
export function writesUnreadableNumber(text: string, number: string): boolean {
  const wanted = number.replace(/\D/g, "");
  for (const [written] of text.matchAll(NUMBER_SHAPED)) {
    const digits = written.replace(/\D/g, "");
    if (
      digits.length < 7 ||
      digits.length > 15 ||
      !samePhoneNumber(digits, wanted)
    )
      continue;
    try {
      phoneDialNumber(written.trim());
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * A refused number: with swapped numbers, the references to copy instead;
 * without them, a number the owner wrote in a form nobody can read asks them
 * to type it again.
 */
function numberRefusal(
  references: readonly SwappedPhoneReference[],
  text: string,
  proposed: string,
): DeviceTelephonyTargetNotRequestedError {
  if (references.length === 0 && writesUnreadableNumber(text, proposed))
    return new DeviceTelephonyTargetNotRequestedError("unreadable");
  return new DeviceTelephonyTargetNotRequestedError(
    "number",
    references.map((reference) => reference.placeholder),
  );
}

/**
 * The owner's number for a proposed one. When the owner's number was swapped,
 * the proposal must be that number's restored reference (an optional country
 * code before it aside): digits equal to it can only come from the reference,
 * since the planner never saw them. Any other digits are invented, unless they
 * are a number the owner wrote that the planner saw as written.
 */
function groundedNumber(
  proposed: string,
  owned: OwnedNumbers,
  references: readonly SwappedPhoneReference[],
  text: string,
): string {
  const number = ownerNumber(proposed, owned);
  // Only a number that can be the recipient is offered: never one in the body.
  if (!number)
    throw numberRefusal(
      references.filter((reference) =>
        owned.flat().some((owner) => samePhoneNumber(owner, reference.number)),
      ),
      text,
      proposed,
    );
  return number;
}

function groundTarget(
  target:
    | { kind: "number"; number: string }
    | { kind: "contact"; query: string },
  text: string,
  body: unknown,
  references: readonly SwappedPhoneReference[],
): AuthoredTelephonyTarget {
  if (target.kind === "number")
    return {
      kind: "number",
      number: groundedNumber(
        target.number,
        recipientNumbers(text, body, target.number),
        references,
        textWithoutBody(text, body).text,
      ),
    };
  const named = (rest: string) => writesContactName(rest, target.query);
  if (!named(textWithoutBody(text, body, named).text))
    throw new DeviceTelephonyTargetNotRequestedError("contact");
  return target;
}

type TargetedOperation = Extract<
  DeviceOperation,
  | { type: "phone_call" | "phone_dial" }
  | { type: "sms_compose"; target: unknown }
>;

function withTarget<T extends TargetedOperation>(
  operation: T,
  target: AuthoredTelephonyTarget,
): T {
  return { ...operation, target };
}

// Words around a name that say how or which line, never who: "mom again",
// "Maya's mobile", "Sam back right now".
const NOT_A_NAME_AROUND = new Set([
  ...NOT_A_NAME,
  ..."again right away asap home work office landline line phone".split(" "),
]);

/**
 * Whether the model's contact name is the owner's own, with only words that
 * name nobody dropped around it: "mom" for the written "mom again", "Maya"
 * for "Maya's mobile". A shorter part of a full name ("Sam" for "Sam Lee")
 * is never taken: it would match more contacts than the owner named.
 */
function ownerNameWithoutFiller(authored: string, proposed: string): boolean {
  const owner = normalizedWords(authored).split(" ");
  const name = normalizedWords(proposed).split(" ");
  if (!name[0] || name.length >= owner.length) return false;
  for (let at = 0; at + name.length <= owner.length; at++)
    if (
      name.every((word, i) => owner[at + i] === word) &&
      [...owner.slice(0, at), ...owner.slice(at + name.length)].every((word) =>
        NOT_A_NAME_AROUND.has(word),
      )
    )
      return true;
  return false;
}

/** An empty keypad: it names nobody, never dials, and needs no grounding. */
const EMERGENCY_KEYPAD = { type: "phone_keypad" } as DeviceOperation;

function callOrKeypad(operation: DeviceOperation): boolean {
  return (
    operation.type === "phone_call" ||
    operation.type === "phone_dial" ||
    operation.type === "phone_keypad"
  );
}

/**
 * The operation with its recipient grounded in the owner's authored text of
 * this message, or a {@link DeviceTelephonyTargetNotRequestedError}. An
 * emergency request ("call an ambulance", "call the police", "call for help")
 * whose call or keypad would otherwise be refused, or that names the service
 * as a contact, opens the empty keypad instead (`emergency: true`): the owner
 * dials their local emergency number there and the system dialer handles it.
 * It is never refused for its recipient. A number the owner wrote ("call
 * 911") is still the reviewed recipient, which the phone hands to the system
 * dialer.
 */
export function groundTelephonyTarget(
  operation: DeviceOperation,
  text: string,
  references: readonly SwappedPhoneReference[] = [],
): { operation: DeviceOperation; handedThrough: boolean; emergency?: true } {
  const emergency = callOrKeypad(operation) && emergencyServicesRequest(text);
  if (
    emergency &&
    (operation.type === "phone_call" || operation.type === "phone_dial") &&
    operation.target.kind === "contact" &&
    namesEmergencyService(operation.target.query)
  )
    return { operation: EMERGENCY_KEYPAD, handedThrough: false, emergency };
  try {
    return groundOwnerTarget(operation, text, references);
  } catch (error) {
    if (emergency && error instanceof DeviceTelephonyTargetNotRequestedError)
      return { operation: EMERGENCY_KEYPAD, handedThrough: false, emergency };
    throw error;
  }
}

/**
 * The operation with its recipient grounded in the owner's authored text of
 * this message, or a {@link DeviceTelephonyTargetNotRequestedError}:
 *
 * - A whole-message "call X" or "text X saying …" command (the device.telephony
 *   route) hands through the recipient the owner wrote, whatever the model
 *   proposed: their number in its dial form, or the name they wrote, which
 *   the phone resolves to that contact's own number on the device (and asks
 *   which one when several match).
 * - Otherwise a proposed number must be one the owner wrote (country code
 *   aside; the owner's dial form is kept), and a proposed contact name must be
 *   one they wrote. A number written inside the SMS body is never a recipient.
 * - A keypad prefill must be a number the owner wrote; an empty keypad is fine.
 *
 * Phone contacts never leave the phone, so a name the address book does not
 * know is refused there (`not-found`), never matched to a number here.
 */
function groundOwnerTarget(
  operation: DeviceOperation,
  text: string,
  references: readonly SwappedPhoneReference[],
): { operation: DeviceOperation; handedThrough: boolean } {
  const authored = authoredTelephonyTarget(text);
  const command =
    authored &&
    (authored.request === "call"
      ? operation.type === "phone_call" || operation.type === "phone_dial"
      : operation.type === "sms_compose" || operation.type === "sms_send");
  if (command) {
    // Number-shaped, but not one dial number: the owner retypes it.
    if (!authored.target)
      throw new DeviceTelephonyTargetNotRequestedError("unreadable");
    let target = authored.target;
    const proposed =
      operation.type === "phone_call" || operation.type === "phone_dial"
        ? operation.target
        : operation.type === "sms_compose"
          ? "target" in operation
            ? operation.target
            : { kind: "contact" as const, query: operation.query }
          : undefined;
    // The model's name when it is the owner's with only words that name
    // nobody dropped ("mom" for "mom again"): the phone looks it up as is.
    if (
      target.kind === "contact" &&
      proposed?.kind === "contact" &&
      writesContactName(text, proposed.query) &&
      ownerNameWithoutFiller(target.query, proposed.query)
    )
      target = { kind: "contact", query: proposed.query.trim() };
    if (operation.type === "phone_call" || operation.type === "phone_dial")
      return { operation: withTarget(operation, target), handedThrough: true };
    if (operation.type === "sms_compose") {
      if ("target" in operation)
        return {
          operation: withTarget(operation, target),
          handedThrough: true,
        };
      // The query form names a contact; it cannot carry a written number.
      if (target.kind !== "contact")
        throw new DeviceTelephonyTargetNotRequestedError("form");
      return {
        operation: { ...operation, query: target.query },
        handedThrough: true,
      };
    }
    if (operation.type === "sms_send") {
      // A SIM send takes numbers only; a name is resolved on the phone.
      if (target.kind !== "number")
        throw new DeviceTelephonyTargetNotRequestedError("form");
      return {
        operation: { ...operation, recipients: [target.number] },
        handedThrough: true,
      };
    }
  }
  switch (operation.type) {
    case "phone_call":
    case "phone_dial":
      return {
        operation: withTarget(
          operation,
          groundTarget(operation.target, text, undefined, references),
        ),
        handedThrough: false,
      };
    case "sms_compose":
      if ("target" in operation)
        return {
          operation: withTarget(
            operation,
            groundTarget(operation.target, text, operation.body, references),
          ),
          handedThrough: false,
        };
      groundTarget(
        { kind: "contact", query: operation.query },
        text,
        operation.body,
        references,
      );
      return { operation, handedThrough: false };
    case "sms_send": {
      const recipients = operation.recipients.map((recipient) =>
        groundedNumber(
          recipient,
          recipientNumbers(text, operation.body, recipient),
          references,
          textWithoutBody(text, operation.body).text,
        ),
      );
      return { operation: { ...operation, recipients }, handedThrough: false };
    }
    case "phone_keypad": {
      if (operation.number === undefined)
        return { operation, handedThrough: false };
      const number = groundedNumber(
        operation.number,
        ownerPhoneNumberTiers(text),
        references,
        text,
      );
      return { operation: { ...operation, number }, handedThrough: false };
    }
    case "contact_create":
    case "contact_update":
      return {
        operation: groundContactNumbers(operation, text, references),
        handedThrough: false,
      };
    default:
      return { operation, handedThrough: false };
  }
}

type ContactNumberOperation = Extract<
  DeviceOperation,
  { type: "contact_create" | "contact_update" }
>;

/**
 * A contact change's numbers, each one the owner wrote in this message (in
 * the owner's dial form), when the message writes any number. A message that
 * writes no number has nothing to ground a number in and is left unchanged,
 * for the owner's review of the exact digits.
 */
function groundContactNumbers(
  operation: ContactNumberOperation,
  text: string,
  references: readonly SwappedPhoneReference[],
): ContactNumberOperation {
  const owned = ownerPhoneNumberTiers(text);
  if (!owned.flat().length || !contactNumbers(operation).length)
    return operation;
  const grounded = (numbers: string[]) => [
    ...new Set(
      numbers.map((number) => groundedNumber(number, owned, references, text)),
    ),
  ];
  if (operation.type === "contact_create")
    return {
      ...operation,
      contact: {
        ...operation.contact,
        phoneNumbers: grounded(operation.contact.phoneNumbers),
      },
    };
  const update: ContactNumberOperation = { ...operation };
  for (const part of CONTACT_NUMBER_PARTS) {
    const values = operation[part];
    if (values?.phoneNumbers)
      update[part] = { ...values, phoneNumbers: grounded(values.phoneNumbers) };
  }
  return update;
}
