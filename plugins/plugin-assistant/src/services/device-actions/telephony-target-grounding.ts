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
import type { DeviceOperation } from "./contract.ts";
import { phoneDialNumber } from "./phone-dial-contract.ts";
import {
  type AuthoredTelephonyTarget,
  authoredTelephonyTarget,
} from "./telephony-request.ts";

/** Why a recipient was refused before persistence. Never a human review decision. */
export type TelephonyTargetRefusal =
  /** A number the owner did not write in this message. */
  | "number"
  /** A contact name the owner did not write in this message. */
  | "contact"
  /** The owner's recipient does not fit a form this phone negotiated. */
  | "form";

/** Policy refusal before persistence; never represents a human review decision. */
export class DeviceTelephonyTargetNotRequestedError extends Error {
  readonly code = "DEVICE_TELEPHONY_TARGET_NOT_REQUESTED";
  constructor(readonly refusal: TelephonyTargetRefusal) {
    super(
      refusal === "form"
        ? "This phone cannot take the recipient the owner wrote in this form. No proposal was created; nothing was called or sent."
        : refusal === "contact"
          ? "The current original request does not name this contact. Use only the name the owner wrote in this message. No proposal was created; nothing was called or sent."
          : "The current original request does not contain this phone number. Use only a number the owner wrote in this message, by copying its contact reference exactly. No proposal was created; nothing was called or sent.",
    );
  }
}

/** The reply the owner sees for a refusal: true whichever recipient was refused. */
export function telephonyTargetRefusalReply(
  refusal: TelephonyTargetRefusal,
): string {
  if (refusal === "form")
    return "I can't set that up on this phone with that recipient. Tell me the number to use.";
  if (refusal === "contact")
    return "I didn't set that up, because that name isn't one you wrote in your message. Nothing was called or sent. Tell me who, by their name as saved in Contacts or their number.";
  return "I didn't set that up, because that number isn't one you wrote in your message. Nothing was called or sent. Tell me the number to use.";
}

/** Operations whose recipient or prefill is a phone number or contact. */
export function namesTelephonyTarget(operation: { type?: unknown }): boolean {
  return (
    operation.type === "phone_call" ||
    operation.type === "phone_dial" ||
    operation.type === "sms_compose" ||
    operation.type === "sms_send" ||
    operation.type === "phone_keypad"
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
 * The owner's text without the message body they asked to send, so that "text
 * Sam saying call me at 415-555-0100" never makes that number the recipient.
 */
function textWithoutBody(
  text: string,
  body: unknown,
): { text: string; bodyNumbers: string[] } {
  if (typeof body !== "string" || !body.trim())
    return { text, bodyNumbers: [] };
  const at = text.toLowerCase().indexOf(body.trim().toLowerCase());
  if (at >= 0)
    return {
      text: text.slice(0, at) + " " + text.slice(at + body.trim().length),
      bodyNumbers: [],
    };
  // The model reworded the body: no number it carries can be the recipient.
  return { text, bodyNumbers: writtenPhoneNumbers(body) };
}

function ownerNumber(
  proposed: string,
  owned: readonly string[],
): string | undefined {
  // The owner's own dial form, never the model's spelling of it.
  return owned.find((number) => samePhoneNumber(number, proposed));
}

function recipientNumbers(text: string, body: unknown): string[] {
  const { text: rest, bodyNumbers } = textWithoutBody(text, body);
  return writtenPhoneNumbers(rest).filter(
    (number) => !bodyNumbers.some((inBody) => samePhoneNumber(inBody, number)),
  );
}

function groundTarget(
  target:
    | { kind: "number"; number: string }
    | { kind: "contact"; query: string },
  text: string,
  body: unknown,
): AuthoredTelephonyTarget {
  if (target.kind === "number") {
    const number = ownerNumber(target.number, recipientNumbers(text, body));
    if (!number) throw new DeviceTelephonyTargetNotRequestedError("number");
    return { kind: "number", number };
  }
  if (!writesContactName(textWithoutBody(text, body).text, target.query))
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
export function groundTelephonyTarget(
  operation: DeviceOperation,
  text: string,
): { operation: DeviceOperation; handedThrough: boolean } {
  const authored = authoredTelephonyTarget(text);
  const command =
    authored &&
    (authored.request === "call"
      ? operation.type === "phone_call" || operation.type === "phone_dial"
      : operation.type === "sms_compose" || operation.type === "sms_send");
  if (command) {
    const target = authored.target;
    if (!target) throw new DeviceTelephonyTargetNotRequestedError("number");
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
          groundTarget(operation.target, text, undefined),
        ),
        handedThrough: false,
      };
    case "sms_compose":
      if ("target" in operation)
        return {
          operation: withTarget(
            operation,
            groundTarget(operation.target, text, operation.body),
          ),
          handedThrough: false,
        };
      groundTarget(
        { kind: "contact", query: operation.query },
        text,
        operation.body,
      );
      return { operation, handedThrough: false };
    case "sms_send": {
      const owned = recipientNumbers(text, operation.body);
      const recipients = operation.recipients.map((recipient) => {
        const number = ownerNumber(recipient, owned);
        if (!number) throw new DeviceTelephonyTargetNotRequestedError("number");
        return number;
      });
      return { operation: { ...operation, recipients }, handedThrough: false };
    }
    case "phone_keypad": {
      if (operation.number === undefined)
        return { operation, handedThrough: false };
      const number = ownerNumber(operation.number, writtenPhoneNumbers(text));
      if (!number) throw new DeviceTelephonyTargetNotRequestedError("number");
      return { operation: { ...operation, number }, handedThrough: false };
    }
    default:
      return { operation, handedThrough: false };
  }
}
