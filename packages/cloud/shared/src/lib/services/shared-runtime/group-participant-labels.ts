/**
 * Single source of group-chat speaker identity for the Shared runtime: the
 * model-facing label, the outbound guard that keeps raw connector handles out
 * of a reply, and the one prompt rule that tells the model what the label is
 * not.
 *
 * The label is deliberately ordinary language. It is prefixed onto the text
 * the model reads and it is the model's only handle on "who said this", so a
 * model that repeats it must produce something a group can read without harm.
 * The label it replaced was a truncated SHA-256 of the speaker's phone number,
 * which failed exactly that test in production.
 *
 * Nothing here imports the database: the format is pure string logic so the
 * route, the guard, and the tests can all share one definition instead of
 * re-spelling it.
 */

/**
 * The one rule a group turn adds to the character's system prompt.
 *
 * `Participant 3` is a slot, not a name. Without this the model treats the
 * label as the person's identifier and addresses them by it, which reads as
 * machinery to everyone else in the room; the digest form it replaced was
 * echoed verbatim into a live group. Names come from the conversation itself
 * ("thanks Ada"), which is also where a human would get them.
 */
export const GROUP_TURN_NAMING_RULE =
  "Several people are talking in this group. Call someone by the name they are " +
  "called in the conversation. If no name has been used for them, speak to them " +
  "directly instead of inventing or repeating an identifier for them.";

/**
 * Appends {@link GROUP_TURN_NAMING_RULE} to a character's system prompt for one
 * group turn. Idempotent, so a system prompt that already carries the rule is
 * returned unchanged rather than accumulating copies.
 */
export function withGroupTurnNamingRule(system: string): string {
  const base = system.trim();
  if (!base) return GROUP_TURN_NAMING_RULE;
  if (base.includes(GROUP_TURN_NAMING_RULE)) return base;
  return `${base}\n\n${GROUP_TURN_NAMING_RULE}`;
}

/**
 * Matches exactly what {@link groupParticipantLabel} builds for an unnamed
 * participant. Anchored, because a label is a whole speaker name, never a
 * fragment of one.
 */
export const GROUP_PARTICIPANT_LABEL_PATTERN = /^Participant (\d+)$/;

/**
 * A handle shorter than this is not redacted from outbound text. Real connector
 * handles are phone numbers or platform user ids and are comfortably longer;
 * a two- or three-character handle would match ordinary words and numbers in
 * a reply, and corrupting every reply is a worse failure than the leak this
 * guards against. Kept as a named constant so the tradeoff is visible.
 */
export const GROUP_HANDLE_REDACTION_MIN_LENGTH = 6;

/** Non-alphanumeric on both sides, so a handle inside a longer token is left alone. */
const HANDLE_BOUNDARY = "[0-9A-Za-z]";

export interface GroupParticipantLabelInput {
  /**
   * Reserved name slot from the participant registry. No writer populates it
   * yet, so today every group label is the ordinal form.
   */
  displayName?: string | null;
  /** 1-based, stable within a binding. */
  ordinal: number;
}

/**
 * The one place the group speaker label format is spelled out.
 *
 * Blank display names fall through to the ordinal: the registry forbids an
 * empty string, but a caller that has not been through the registry (a future
 * name source, a test) must not be able to produce a nameless label.
 */
export function groupParticipantLabel(participant: GroupParticipantLabelInput): string {
  if (!Number.isSafeInteger(participant.ordinal) || participant.ordinal <= 0) {
    throw new TypeError("Group participant ordinal must be a positive integer");
  }
  const name = participant.displayName?.trim();
  return name ? name : `Participant ${participant.ordinal}`;
}

/** True for the generated ordinal label; the recogniser paired with the builder. */
export function isGroupParticipantLabel(value: string): boolean {
  return GROUP_PARTICIPANT_LABEL_PATTERN.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every spelling of one handle the guard will redact: the handle as the
 * connector sent it, plus its digits-only core when the handle carries
 * separators (`+1 555-0100` is the same person as `15550100`).
 */
function handleVariants(platformUserId: string): string[] {
  const raw = platformUserId.trim();
  const variants = new Set<string>();
  if (raw.length >= GROUP_HANDLE_REDACTION_MIN_LENGTH) variants.add(raw);
  const digits = raw.replace(/\D/g, "");
  if (digits.length >= GROUP_HANDLE_REDACTION_MIN_LENGTH) variants.add(digits);
  return [...variants];
}

/**
 * Replaces any participant's raw connector handle in outbound group text with
 * that participant's label.
 *
 * The model is never shown a handle, so in the ordinary case this changes
 * nothing — it is insurance on a PII boundary where the cost of being wrong is
 * a phone number broadcast to a group chat. Matching is boundary-guarded and
 * floored at {@link GROUP_HANDLE_REDACTION_MIN_LENGTH} so ordinary prose,
 * prices, dates, and URLs pass through untouched. Longest variant first, so a
 * handle that is a prefix of another is not half-replaced.
 */
export function redactGroupParticipantHandles(
  text: string,
  roster: readonly (GroupParticipantLabelInput & { platformUserId: string })[],
): string {
  if (!text) return text;
  const replacements = roster
    .flatMap((participant) =>
      handleVariants(participant.platformUserId).map((variant) => ({
        variant,
        label: groupParticipantLabel(participant),
      })),
    )
    .sort((a, b) => b.variant.length - a.variant.length);
  let guarded = text;
  for (const { variant, label } of replacements) {
    guarded = guarded.replace(
      new RegExp(`(?<!${HANDLE_BOUNDARY})${escapeRegExp(variant)}(?!${HANDLE_BOUNDARY})`, "g"),
      label,
    );
  }
  return guarded;
}
