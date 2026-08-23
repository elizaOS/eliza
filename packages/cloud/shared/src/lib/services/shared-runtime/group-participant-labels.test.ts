/**
 * Pins the model-facing group speaker label, the group-turn naming rule, and
 * the outbound handle guard. The label is the only identity the model has for
 * a participant and it is returned verbatim to a group chat when the model
 * echoes it, so its shape, the rule that keeps it from being mistaken for a
 * name, and the guard's refusal to touch ordinary prose are all contract.
 */
import { describe, expect, test } from "bun:test";
import {
  GROUP_HANDLE_REDACTION_MIN_LENGTH,
  GROUP_TURN_NAMING_RULE,
  groupParticipantLabel,
  isGroupParticipantLabel,
  redactGroupParticipantHandles,
  withGroupTurnNamingRule,
} from "./group-participant-labels";

const ADA = { platformUserId: "+15551234567", ordinal: 1, displayName: null };
const BRIT = { platformUserId: "987654321012", ordinal: 2, displayName: null };

describe("groupParticipantLabel", () => {
  test("names an unnamed participant by ordinal, in ordinary language", () => {
    expect(groupParticipantLabel({ ordinal: 3, displayName: null })).toBe("Participant 3");
    // No display-name source exists yet, so an omitted field must behave as null.
    expect(groupParticipantLabel({ ordinal: 1 })).toBe("Participant 1");
    // Nothing high-entropy survives into the label: a model that repeats it
    // broadcasts a readable phrase, not a token.
    expect(groupParticipantLabel({ ordinal: 12 })).toMatch(/^Participant \d+$/);
  });

  test("prefers a display name once a name source populates one", () => {
    expect(groupParticipantLabel({ ordinal: 2, displayName: "Ada" })).toBe("Ada");
    // Blank is not a name: it must not produce a nameless label.
    expect(groupParticipantLabel({ ordinal: 2, displayName: "   " })).toBe("Participant 2");
    expect(groupParticipantLabel({ ordinal: 2, displayName: "  Ada  " })).toBe("Ada");
  });

  test("refuses an ordinal that could not have come from the registry", () => {
    expect(() => groupParticipantLabel({ ordinal: 0 })).toThrow(TypeError);
    expect(() => groupParticipantLabel({ ordinal: -1 })).toThrow(TypeError);
    expect(() => groupParticipantLabel({ ordinal: 1.5 })).toThrow(TypeError);
  });
});

describe("isGroupParticipantLabel", () => {
  test("recognises exactly what the builder builds", () => {
    expect(isGroupParticipantLabel(groupParticipantLabel({ ordinal: 7 }))).toBe(true);
    expect(isGroupParticipantLabel("Participant 7")).toBe(true);
    expect(isGroupParticipantLabel("participant 7")).toBe(false);
    expect(isGroupParticipantLabel("Participant")).toBe(false);
    expect(isGroupParticipantLabel("Participant 7 Smith")).toBe(false);
    // A label is a whole speaker name, never a fragment of a sentence.
    expect(isGroupParticipantLabel("ask Participant 7 about it")).toBe(false);
  });
});

describe("withGroupTurnNamingRule", () => {
  test("adds the rule after the character's own system prompt", () => {
    expect(withGroupTurnNamingRule("You are Eliza.")).toBe(
      `You are Eliza.\n\n${GROUP_TURN_NAMING_RULE}`,
    );
    expect(withGroupTurnNamingRule("")).toBe(GROUP_TURN_NAMING_RULE);
  });

  test("does not accumulate copies of itself", () => {
    const once = withGroupTurnNamingRule("You are Eliza.");
    expect(withGroupTurnNamingRule(once)).toBe(once);
  });

  test("names no identifier scheme the model could imitate", () => {
    // The rule must not itself teach the label format, or the model will use
    // it as a name instead of looking for one in the conversation.
    expect(GROUP_TURN_NAMING_RULE).not.toContain("Participant");
  });
});

describe("redactGroupParticipantHandles", () => {
  test("replaces a participant's phone number with their label", () => {
    expect(redactGroupParticipantHandles("Text +15551234567 when you land.", [ADA, BRIT])).toBe(
      "Text Participant 1 when you land.",
    );
  });

  test("catches the handle written without its separators", () => {
    // The model never sees the handle, but if one ever reached it through
    // conversation content it could be re-emitted in a different spelling.
    expect(redactGroupParticipantHandles("reach them on 15551234567", [ADA])).toBe(
      "reach them on Participant 1",
    );
  });

  test("redacts every participant of the binding, not only the speaker", () => {
    expect(
      redactGroupParticipantHandles("+15551234567 and 987654321012 are both in", [ADA, BRIT]),
    ).toBe("Participant 1 and Participant 2 are both in");
  });

  test("leaves an ordinary reply untouched", () => {
    const reply =
      "Let's go with Bombay Brasserie at 7:30. It's $45 a head, table for 5, " +
      "and I booked it for 2026-08-23 — see you there!";
    expect(redactGroupParticipantHandles(reply, [ADA, BRIT])).toBe(reply);
    expect(redactGroupParticipantHandles("", [ADA])).toBe("");
    expect(redactGroupParticipantHandles(reply, [])).toBe(reply);
  });

  test("does not split a handle out of a longer token", () => {
    // Boundary-guarded: an id embedded in a longer alphanumeric run (an order
    // number, a URL path, a hash) is not this participant's handle.
    expect(redactGroupParticipantHandles("order 9876543210129 shipped", [BRIT])).toBe(
      "order 9876543210129 shipped",
    );
    expect(redactGroupParticipantHandles("https://x.test/a987654321012b", [BRIT])).toBe(
      "https://x.test/a987654321012b",
    );
  });

  test("skips handles too short to distinguish from ordinary text", () => {
    const short = { platformUserId: "42", ordinal: 1, displayName: null };
    expect("42".length).toBeLessThan(GROUP_HANDLE_REDACTION_MIN_LENGTH);
    expect(redactGroupParticipantHandles("the answer is 42", [short])).toBe("the answer is 42");
  });

  test("consumes the longest spelling first so no fragment of a handle survives", () => {
    // `+15551234567` and its digits-only core are both variants of one handle.
    // Matching the shorter one first would leave a stray `+` in the reply, and
    // matching a prefix handle first would leave the rest of a longer one.
    expect(redactGroupParticipantHandles("call +15551234567", [ADA])).toBe("call Participant 1");
    const prefix = { platformUserId: "987654321", ordinal: 3, displayName: null };
    expect(redactGroupParticipantHandles("call 987654321012", [prefix, BRIT])).toBe(
      "call Participant 2",
    );
  });
});
