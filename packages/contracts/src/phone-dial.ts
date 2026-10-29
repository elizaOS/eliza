/**
 * Reviewed dial handoff and owner-scoped contact lookup for installs with the
 * native AOSP telephony profile (`./native-telephony.ts`).
 *
 * `phone.dial.v1` is a handoff: after the owner approves the exact number on
 * the unlocked phone, the device opens the system dial screen with that number
 * filled in. The person places (or does not place) the call there, and the
 * system dialer keeps emergency numbers. A result therefore never reports a
 * placed, connected or completed call; it names only who owns the effect next.
 *
 * `contacts.lookup.v1` lets a dial request name a contact instead of a number.
 * The lookup runs on the phone, inside the owner's own profile and only while
 * the review is in front; matching address-book rows stay on the device and
 * the owner picks the number to hand off. The agent receives the handoff
 * result, never the address book.
 *
 * Both capabilities are advertised only when the native telephony profile is
 * present ({@link telephonyDeviceCapabilities}); every other install, including
 * Eliza's own app without the profile, advertises neither.
 */

export const PHONE_DIAL_CAPABILITY = "phone.dial.v1";
export const CONTACT_LOOKUP_CAPABILITY = "contacts.lookup.v1";

/** Digits with an optional leading +, the same shape the native dial handoff accepts. */
export const PHONE_DIAL_NUMBER = /^\+?[0-9]{2,20}$/;
export const CONTACT_LOOKUP_MAX_QUERY = 128;
export const CONTACT_LOOKUP_MAX_RESULTS = 10;

export type PhoneDialTarget =
  | { kind: "number"; number: string }
  | { kind: "contact"; query: string };

export type PhoneDialOperation = {
  type: "phone_dial";
  target: PhoneDialTarget;
};

export type PhoneDialStatus =
  | "handed-off"
  | "unavailable"
  | "cancelled"
  | "failed";
/**
 * What the phone observed after the owner's review. `handed-off` means the
 * dial screen opened with the reviewed number; it is never a placed call.
 * `contact` is true when the owner chose the number from a contact lookup.
 */
export type PhoneDialResult = {
  kind: "phone-dial";
  status: PhoneDialStatus;
  handler: string | null;
  contact: boolean;
};

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
// C0/C1 controls, bidi overrides and lone surrogates never reach a review or a provider query.
const UNSAFE_TEXT =
  /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

/** The contact search text a lookup may use: trimmed, 1..128 characters, no controls. */
export function validateContactLookupQuery(value: unknown): string {
  if (typeof value !== "string") throw Error("Invalid contact lookup");
  const query = value.trim();
  if (
    !query ||
    query.length > CONTACT_LOOKUP_MAX_QUERY ||
    query !== value ||
    UNSAFE_TEXT.test(query)
  )
    throw Error("Invalid contact lookup");
  return query;
}

export function isPhoneDial(value: {
  type?: unknown;
}): value is PhoneDialOperation {
  return value.type === "phone_dial";
}

/** Exact, closed validation; it rejects rather than normalizes. */
export function validatePhoneDial(value: unknown): PhoneDialOperation {
  const v = record(value, "dial");
  exact(v, ["type", "target"], "dial");
  if (v.type !== "phone_dial") throw Error("Invalid dial");
  const target = record(v.target, "dial target");
  if (target.kind === "number") {
    exact(target, ["kind", "number"], "dial target");
    if (
      typeof target.number !== "string" ||
      !PHONE_DIAL_NUMBER.test(target.number)
    )
      throw Error("Invalid dial number");
    return {
      type: "phone_dial",
      target: { kind: "number", number: target.number },
    };
  }
  if (target.kind === "contact") {
    exact(target, ["kind", "query"], "dial target");
    return {
      type: "phone_dial",
      target: {
        kind: "contact",
        query: validateContactLookupQuery(target.query),
      },
    };
  }
  throw Error("Invalid dial target");
}

/** The capabilities a dial operation needs: a contact target also needs the lookup. */
export function phoneDialCapabilityAvailable(
  operation: Pick<PhoneDialOperation, "target"> | undefined,
  capabilities: readonly string[] | undefined,
): boolean {
  if (!capabilities?.includes(PHONE_DIAL_CAPABILITY)) return false;
  return (
    operation?.target.kind !== "contact" ||
    capabilities.includes(CONTACT_LOOKUP_CAPABILITY)
  );
}

const DIAL_STATUS: readonly PhoneDialStatus[] = [
  "handed-off",
  "unavailable",
  "cancelled",
  "failed",
];

/**
 * Validates a device result for the reviewed operation. A number target cannot
 * report a contact choice, and no field can claim a placed or connected call.
 */
export function validatePhoneDialResult(
  operation: PhoneDialOperation,
  value: unknown,
): PhoneDialResult {
  const v = record(value, "dial result");
  exact(v, ["kind", "status", "handler", "contact"], "dial result");
  if (
    v.kind !== "phone-dial" ||
    !DIAL_STATUS.includes(v.status as PhoneDialStatus) ||
    typeof v.contact !== "boolean" ||
    (v.handler !== null &&
      (typeof v.handler !== "string" ||
        !v.handler ||
        v.handler.length > 256 ||
        UNSAFE_TEXT.test(v.handler)))
  )
    throw Error("Invalid dial result");
  if (v.contact && operation.target.kind !== "contact")
    throw Error("A number dial cannot report a contact choice");
  if (v.status !== "handed-off" && v.handler !== null)
    throw Error("Only an opened dial screen names its handler");
  return {
    kind: "phone-dial",
    status: v.status as PhoneDialStatus,
    handler: v.handler as string | null,
    contact: v.contact,
  };
}

/** `applied` only when the dial screen opened; every other status is a
 * `failed` receipt (nothing was dialed). */
export function phoneDialReceiptOutcome(
  result: PhoneDialResult,
): "applied" | "failed" {
  return result.status === "handed-off" ? "applied" : "failed";
}

/** Fixed, factual text for a dial receipt. It never says a call was placed. */
export function phoneDialResultText(result: PhoneDialResult): string {
  switch (result.status) {
    case "handed-off":
      return "The phone app opened with the reviewed number. The owner places the call there; this does not show whether a call was placed or connected.";
    case "cancelled":
      return "The owner cancelled the dial review. Nothing was dialed.";
    case "unavailable":
      return "No phone app could open the number on this phone. Nothing was dialed.";
    case "failed":
      return "The phone app could not be opened. Nothing was dialed.";
  }
}

/** One address-book match shown to the owner on the phone. Never sent to the agent. */
export type ContactLookupMatch = {
  id: string;
  displayName: string;
  phoneNumbers: string[];
};

/**
 * Bounds a contact search result for the on-device review: at most ten
 * contacts with at least one dialable number, numbers normalized to the dial
 * shape and deduplicated. Rows without a dialable number are dropped.
 */
export function contactLookupMatches(
  rows: readonly {
    id: string;
    displayName: string;
    phoneNumbers: readonly string[];
  }[],
  normalize: (value: string) => string | null,
  limit = CONTACT_LOOKUP_MAX_RESULTS,
): ContactLookupMatch[] {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > CONTACT_LOOKUP_MAX_RESULTS
  )
    throw new RangeError("Contact lookup limit must be 1 to 10");
  const matches: ContactLookupMatch[] = [];
  for (const row of rows) {
    if (matches.length >= limit) break;
    const numbers = [
      ...new Set(
        row.phoneNumbers
          .map((value) => normalize(value))
          .filter(
            (value): value is string =>
              !!value && PHONE_DIAL_NUMBER.test(value),
          ),
      ),
    ];
    if (!numbers.length) continue;
    matches.push({
      id: row.id,
      displayName: row.displayName.trim() || "Unnamed contact",
      phoneNumbers: numbers,
    });
  }
  return matches;
}

/**
 * Device-action capabilities a telephony host may advertise. Without the
 * native profile the answer is empty; contact lookup also needs the host's
 * contact search.
 */
export function telephonyDeviceCapabilities(profile: {
  present: boolean;
  dial: boolean;
  contactLookup: boolean;
}): string[] {
  if (!profile.present || !profile.dial) return [];
  return profile.contactLookup
    ? [PHONE_DIAL_CAPABILITY, CONTACT_LOOKUP_CAPABILITY]
    : [PHONE_DIAL_CAPABILITY];
}
