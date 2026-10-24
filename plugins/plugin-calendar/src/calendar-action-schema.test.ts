/**
 * The CALENDAR details schema is offered to the planner as a tool schema. This
 * module already drops `oneOf` for provider strict mode (see `recurrenceSchema`),
 * so the schema must also stay inside the keyword set those grammars accept.
 * The host still checks the note reference in `parseCalendarNoteSource`.
 */
import { describe, expect, it } from "vitest";
import { CALENDAR_DETAILS_PARAMETER_SCHEMA } from "./calendar-action-schema.js";
import { parseCalendarNoteSource } from "./internal/note-source.js";

function collectPatternPaths(value: unknown, path: string, found: string[]) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      collectPatternPaths(entry, `${path}[${index}]`, found);
    }
    return;
  }
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, "pattern")) found.push(path);
  for (const [key, child] of Object.entries(record)) {
    if (key === "properties" && child && typeof child === "object") {
      for (const [name, property] of Object.entries(
        child as Record<string, unknown>,
      )) {
        collectPatternPaths(property, `${path}.${name}`, found);
      }
      continue;
    }
    if (
      key === "items" ||
      key === "anyOf" ||
      key === "oneOf" ||
      key === "additionalProperties"
    ) {
      collectPatternPaths(child, `${path}.${key}`, found);
    }
  }
}

describe("Calendar details schema", () => {
  it("offers the note reference without a model-side pattern", () => {
    const found: string[] = [];
    collectPatternPaths(CALENDAR_DETAILS_PARAMETER_SCHEMA, "details", found);
    expect(found).toEqual([]);

    const sourceNote = CALENDAR_DETAILS_PARAMETER_SCHEMA.properties?.sourceNote;
    if (sourceNote?.type !== "object" || !sourceNote.properties) {
      throw new Error("Expected an object sourceNote schema");
    }
    expect(sourceNote.properties.contentHash).toEqual({ type: "string" });
    expect(sourceNote.required).toEqual(["agentId", "noteId", "contentHash"]);
    expect(sourceNote.additionalProperties).toBe(false);
  });

  it("keeps the host note-reference check", () => {
    expect(() =>
      parseCalendarNoteSource({
        agentId: "agent",
        noteId: "note",
        contentHash: "A".repeat(64),
      }),
    ).toThrow(/complete sourceNote reference/);
    expect(() =>
      parseCalendarNoteSource({
        agentId: "agent",
        noteId: "note",
        contentHash: "a".repeat(63),
      }),
    ).toThrow(/complete sourceNote reference/);
    expect(
      parseCalendarNoteSource({
        agentId: "agent",
        noteId: "note",
        contentHash: "a".repeat(64),
      }),
    ).toEqual({
      agentId: "agent",
      noteId: "note",
      contentHash: "a".repeat(64),
    });
  });
});
