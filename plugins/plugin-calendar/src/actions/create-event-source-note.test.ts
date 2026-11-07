/**
 * A planner-proposed details.sourceNote is a hint, never note authority.
 * Invented values seen in live CALENDAR_CREATE_EVENT turns (contentHash
 * "unknown"/"today"/truncated hex, noteId "unknown") must not fail argument
 * validation and force a second planner call; they must reach the handler and
 * create without provenance. A real reference is still verified exactly by the
 * original-request extraction, and a well-formed wrong one is rejected.
 */
import { validateToolArgs } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { calendarOperationActions } from "../calendar-read-parameters.js";
import { parseCalendarNoteSource } from "../internal/note-source.js";
import { calendarAction } from "./calendar.js";
import { buildCreateEventRequest } from "./calendar-handler.js";
import { validateCalendarCreateAuthority } from "./create-event-authority.js";

const createAction = calendarOperationActions(calendarAction).find(
  (action) => action.name === "CALENDAR_CREATE_EVENT",
);
if (!createAction) throw new Error("CALENDAR_CREATE_EVENT is not registered");

const request = "Add tea today at 4pm";
const source = { id: "current:one", text: request };
const evidence = [{ sourceId: source.id, quote: source.text }];
const guestNone = { state: "none", evidence, guests: [] };
const verified = {
  agentId: "agent-1",
  noteId: "note-1",
  contentHash: "a".repeat(64),
};

// Shapes recorded in claude-qa-745/759 trajectories that the old
// ^[a-f0-9]{64}$ argument pattern rejected before the handler ran.
const invented = [
  { agentId: "eliza", noteId: "unknown", contentHash: "unknown" },
  { agentId: "walk", noteId: "9pm", contentHash: "today" },
  { agentId: "agent-1", noteId: "unknown", contentHash: "" },
  {
    agentId: "agent-1",
    noteId: "unknown-note-id",
    contentHash: "unknown-hash",
  },
  {
    agentId: "agent-1",
    noteId: "session:agent:alpha",
    contentHash: "6fbb7b52-bb9b-0e96-8342-6f71458eef76",
  },
  {
    agentId: "agent-1",
    noteId: "session:agent:alpha",
    contentHash: "6fbb7b52bb9b0e9683426f71458eef76",
  },
];
// Well-formed but fabricated: these already passed the pattern.
const wellFormedWrong = [
  { agentId: "agent-1", noteId: "none", contentHash: "b".repeat(64) },
  { agentId: "agent-1", noteId: "note-1", contentHash: "c".repeat(64) },
];

function plannerArgs(sourceNote: unknown) {
  return {
    title: "tea",
    details: {
      start: "2026-10-29T16:00:00",
      end: "2026-10-29T17:00:00",
      sourceNote,
    },
  };
}

function buildWith(
  plannerSourceNote: unknown,
  extractedSourceNote: unknown = undefined,
) {
  return buildCreateEventRequest({
    details: plannerArgs(plannerSourceNote).details,
    extractedDetails: {
      title: "tea",
      startAt: "2026-10-29T16:00:00",
      endAt: "2026-10-29T17:00:00",
      ...(extractedSourceNote === undefined
        ? {}
        : { sourceNote: extractedSourceNote }),
    },
    explicitTitle: undefined,
    inferredTitle: undefined,
    authorizingUserTexts: [request],
    preferExtractedDetails: true,
    requireExtractedTiming: true,
  }).request;
}

describe("CALENDAR_CREATE_EVENT planner sourceNote", () => {
  it.each(invented)(
    "accepts invented reference %j without a planner retry and grants no provenance",
    (sourceNote) => {
      const validation = validateToolArgs(
        createAction,
        plannerArgs(sourceNote),
      );
      expect(validation.errors).toEqual([]);
      expect(validation.valid).toBe(true);
      expect(buildWith(sourceNote).sourceNote).toBeUndefined();
    },
  );

  it("still rejects a sourceNote that is not the advertised object shape", () => {
    for (const sourceNote of [
      "launch brief",
      { agentId: "agent-1", noteId: "note-1" },
      { ...verified, extra: "x" },
    ]) {
      expect(
        validateToolArgs(createAction, plannerArgs(sourceNote)).valid,
      ).toBe(false);
    }
  });

  it("keeps the service boundary strict for a malformed hash", () => {
    for (const sourceNote of invented) {
      expect(() => parseCalendarNoteSource(sourceNote)).toThrow(
        expect.objectContaining({ code: "CALENDAR_NOTE_SOURCE_INVALID" }),
      );
    }
    expect(parseCalendarNoteSource(verified)).toEqual(verified);
  });

  it("uses an exactly verified note reference from extraction, not the planner value", () => {
    const authority = validateCalendarCreateAuthority(
      {
        guestIntent: guestNone,
        noteIntent: {
          state: "requested",
          evidence,
          sourceNote: verified,
          descriptionMode: "extracted",
        },
      },
      [source],
      [verified],
    );
    expect(authority.sourceNote).toEqual(verified);
    for (const planner of [...invented, ...wellFormedWrong, undefined]) {
      expect(buildWith(planner, authority.sourceNote).sourceNote).toEqual(
        verified,
      );
    }
  });

  it.each(wellFormedWrong)(
    "rejects well-formed reference %j that does not match a verified note",
    (sourceNote) => {
      expect(
        validateToolArgs(createAction, plannerArgs(sourceNote)).valid,
      ).toBe(true);
      // As a planner hint it grants nothing.
      expect(buildWith(sourceNote).sourceNote).toBeUndefined();
      // As extraction's requested note it must match a verified reference exactly.
      expect(() =>
        validateCalendarCreateAuthority(
          {
            guestIntent: guestNone,
            noteIntent: {
              state: "requested",
              evidence,
              sourceNote,
              descriptionMode: "extracted",
            },
          },
          [source],
          [verified],
        ),
      ).toThrow(
        expect.objectContaining({ code: "CALENDAR_NOTE_SOURCE_CONFLICT" }),
      );
    },
  );

  it("never verifies an invented reference copied into extraction", () => {
    for (const sourceNote of invented) {
      expect(() =>
        validateCalendarCreateAuthority(
          {
            guestIntent: guestNone,
            noteIntent: {
              state: "requested",
              evidence,
              sourceNote,
              descriptionMode: "extracted",
            },
          },
          [source],
          [verified],
        ),
      ).toThrow(
        expect.objectContaining({ code: "CALENDAR_NOTE_SOURCE_CONFLICT" }),
      );
    }
  });
});
