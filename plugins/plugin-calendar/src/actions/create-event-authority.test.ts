import { describe, expect, it } from "vitest";
import { validateCalendarCreateAuthority } from "./create-event-authority.js";

const source = { id: "current:one", text: "Create Solo tomorrow at 3pm." };
const none = {
  state: "none",
  evidence: [{ sourceId: source.id, quote: source.text }],
};
const solo = {
  guestIntent: { ...none, guests: [] },
  noteIntent: { ...none, sourceNote: null },
};
describe("canonical Calendar create authority", () => {
  it("uses explicit verified solo intent instead of invented outer guests and note", () => {
    expect(
      validateCalendarCreateAuthority(
        solo,
        [source],
        {
          attendees: [{ email: "fake@acme.com" }],
          sourceNote: { contentHash: "0".repeat(64) },
        },
        [],
      ),
    ).toEqual({});
  });
  it("does not treat omitted guest intent as none", () => {
    expect(() =>
      validateCalendarCreateAuthority(
        { noteIntent: solo.noteIntent },
        [source],
        {},
        [],
      ),
    ).toThrow("Clarify");
  });
  it("rejects an unrelated source quote", () => {
    expect(() =>
      validateCalendarCreateAuthority(
        {
          ...solo,
          guestIntent: {
            ...solo.guestIntent,
            evidence: [{ sourceId: "foreign", quote: source.text }],
          },
        },
        [source],
        {},
        [],
      ),
    ).toThrow("evidence");
  });
  it("blocks a named requested guest without an address", () => {
    expect(() =>
      validateCalendarCreateAuthority(
        {
          ...solo,
          guestIntent: {
            state: "requested",
            evidence: [{ sourceId: source.id, quote: source.text }],
            guests: [{ name: "Dana", email: null, optional: false }],
          },
        },
        [source],
        {},
        [],
      ),
    ).toThrow("Clarify");
  });
  it("does not let none erase an original proposed named guest", () => {
    const original = { id: source.id, text: "Invite Dana tomorrow at 3pm." };
    const intent = {
      ...solo,
      guestIntent: {
        ...solo.guestIntent,
        evidence: [{ sourceId: original.id, quote: original.text }],
      },
      noteIntent: {
        ...solo.noteIntent,
        evidence: [{ sourceId: original.id, quote: original.text }],
      },
    };
    expect(() =>
      validateCalendarCreateAuthority(
        intent,
        [original],
        { attendees: [{ displayName: "Dana", email: "guessed@acme.com" }] },
        [],
      ),
    ).toThrow("Clarify");
  });
  it("preserves an explicitly sourced email", () => {
    const original = {
      id: source.id,
      text: "Invite dana@acme.com tomorrow at 3pm.",
    };
    const evidence = [{ sourceId: original.id, quote: original.text }];
    const result = validateCalendarCreateAuthority(
      {
        guestIntent: {
          state: "requested",
          evidence,
          guests: [{ name: "Dana", email: "dana@acme.com", optional: false }],
        },
        noteIntent: { state: "none", evidence, sourceNote: null },
      },
      [original],
      {},
      [],
    );
    expect(result.attendees).toEqual([
      { email: "dana@acme.com", displayName: "Dana", optional: false },
    ]);
  });
  it("requires clarification for unresolved continuations", () => {
    expect(() =>
      validateCalendarCreateAuthority(
        { ...solo, guestIntent: { ...solo.guestIntent, state: "unresolved" } },
        [source],
        {},
        [],
      ),
    ).toThrow("Clarify");
  });
  it("preserves only an exact verified note reference and rejects stale alternatives", () => {
    const reference = {
      agentId: "owner",
      noteId: "note",
      contentHash: "a".repeat(64),
    };
    const intent = {
      ...solo,
      noteIntent: { ...none, state: "requested", sourceNote: reference },
    };
    expect(
      validateCalendarCreateAuthority(intent, [source], {}, [reference])
        .sourceNote,
    ).toEqual(reference);
    expect(() =>
      validateCalendarCreateAuthority(intent, [source], {}, []),
    ).toThrow("Read the requested note");
  });
});

it("does not let an invented label hide an original guest email", () => {
  const original = {
    id: source.id,
    text: "Invite dana@acme.com tomorrow at 3pm.",
  };
  const evidence = [{ sourceId: original.id, quote: original.text }];
  expect(() =>
    validateCalendarCreateAuthority(
      {
        guestIntent: { state: "none", evidence, guests: [] },
        noteIntent: { state: "none", evidence, sourceNote: null },
      },
      [original],
      {
        attendees: [{ displayName: "invented label", email: "dana@acme.com" }],
      },
      [],
    ),
  ).toThrow("Clarify");
});
it("does not omit a second originally supported guest from a requested subset", () => {
  const original = {
    id: source.id,
    text: "Invite bob@acme.com and eve@acme.com tomorrow at 3pm.",
  };
  const evidence = [{ sourceId: original.id, quote: original.text }];
  expect(() =>
    validateCalendarCreateAuthority(
      {
        guestIntent: {
          state: "requested",
          evidence,
          guests: [{ name: "Bob", email: "bob@acme.com", optional: false }],
        },
        noteIntent: { state: "none", evidence, sourceNote: null },
      },
      [original],
      { attendees: [{ email: "bob@acme.com" }, { email: "eve@acme.com" }] },
      [],
    ),
  ).toThrow("Clarify");
});

it("reads only the bound requester originals and rejects cloned or mutated task evidence", async () => {
  const { bindTaskExtractionContext, readTaskExtractionUserSources } =
    await import("@elizaos/core");
  const message = {
    id: "request",
    roomId: "room",
    entityId: "owner",
    content: { text: "Schedule it." },
  } as import("@elizaos/core").Memory;
  const state = {
    text: "unchanged",
    values: {},
    data: {},
  } as import("@elizaos/core").State;
  const segment = (
    id: string,
    entityId: string,
    roomId: string,
    label = "prior_message:user",
  ) => ({
    id,
    type: "segment",
    source: "prior-dialogue",
    createdAt: 1,
    segment: {
      id,
      label,
      content: "Owner: Invite Dana",
      metadata: { entityId, roomId, speakerName: "Owner" },
    },
  });
  const context = {
    id: "context",
    events: [
      segment("same", "owner", "room"),
      segment("other-owner", "guest", "room"),
      segment("other-room", "owner", "elsewhere"),
      segment("assistant", "owner", "room", "prior_message:agent"),
    ],
    metadata: { messageId: message.id, roomId: message.roomId },
  } as import("@elizaos/core").ContextObject;
  bindTaskExtractionContext(state, message, context, context);
  expect(readTaskExtractionUserSources(state, message)).toEqual([
    { id: "same", text: "Invite Dana" },
  ]);
  expect(
    readTaskExtractionUserSources(structuredClone(state), message),
  ).toBeUndefined();
  expect(
    readTaskExtractionUserSources(state, { ...message, id: "other-request" }),
  ).toBeUndefined();
  state.text = "changed";
  expect(readTaskExtractionUserSources(state, message)).toBeUndefined();
});
