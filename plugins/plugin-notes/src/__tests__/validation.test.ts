/**
 * Unit tests for untrusted Notes boundary validators in validation.ts.
 */

import { describe, expect, it } from "vitest";
import {
  NOTES_SCHEMA_VERSION,
  NOTES_SCHEMA_VERSION_V1,
  reconstructNoteContent,
} from "../types.js";
import {
  isRecord,
  parseCreateNoteInput,
  parseEntityId,
  parseNoteContent,
  parseNotesDocument,
  parseStickyColor,
  parseUpdateNoteInput,
} from "../validation.js";

describe("Notes boundary validation", () => {
  describe("isRecord", () => {
    it("identifies plain objects and rejects primitives or arrays", () => {
      expect(isRecord({ key: "val" })).toBe(true);
      expect(isRecord({})).toBe(true);
      expect(isRecord(null)).toBe(false);
      expect(isRecord([])).toBe(false);
      expect(isRecord("string")).toBe(false);
      expect(isRecord(123)).toBe(false);
      expect(isRecord(undefined)).toBe(false);
    });
  });

  describe("parseNoteContent", () => {
    it("splits single-line content into title and empty body", () => {
      const result = parseNoteContent("Simple Note Title");
      expect(result).toEqual({
        title: "Simple Note Title",
        body: "",
      });
    });

    it("splits multi-line content into a label plus the verbatim remainder", () => {
      const result = parseNoteContent(
        "Header Line\nFirst paragraph\nSecond paragraph",
      );
      expect(result).toEqual({
        title: "Header Line",
        body: "\nFirst paragraph\nSecond paragraph",
      });
    });

    it('splits a one-line "Label: details" note at the labelled colon', () => {
      // Planners flatten "create a note titled X saying Y" and users write
      // "create a note called X: Y" into exactly this one-line shape. The body
      // carries the same leading "\n" separator a two-line note produces so the
      // shared `reconstructNoteContent` yields coherent text rather than the
      // label and details jammed together ("Demo Checklistmic, charger, water").
      const demo = parseNoteContent("Demo Checklist: mic, charger, water");
      expect(demo).toEqual({
        title: "Demo Checklist",
        body: "\nmic, charger, water",
      });
      expect(reconstructNoteContent(demo)).toBe(
        "Demo Checklist\nmic, charger, water",
      );
      expect(parseNoteContent("Groceries: eggs, bread")).toEqual({
        title: "Groceries",
        body: "\neggs, bread",
      });
    });

    it("keeps colons that are not label separators in the title", () => {
      expect(parseNoteContent("https://example.com/docs")).toEqual({
        title: "https://example.com/docs",
        body: "",
      });
      expect(parseNoteContent("Standup at 9:30")).toEqual({
        title: "Standup at 9:30",
        body: "",
      });
      expect(parseNoteContent("re:invent recap")).toEqual({
        title: "re:invent recap",
        body: "",
      });
    });

    it("leaves multi-line content on the first-line label contract", () => {
      // With a real newline present the note is already multi-line, so the
      // labelled-colon one-liner rule does not apply and the verbatim remainder
      // (its leading "\n") is preserved for a lossless round-trip.
      expect(parseNoteContent("Demo Checklist: mic\ncharger")).toEqual({
        title: "Demo Checklist: mic",
        body: "\ncharger",
      });
    });

    it("rejects non-string or empty content", () => {
      expect(() => parseNoteContent(123)).toThrow();
      expect(() => parseNoteContent("   ")).toThrow();
    });

    it("derives a bounded label from a long first line without splitting it", () => {
      const longTitle = `${"a".repeat(239)}😀${"b".repeat(20)}`;
      const result = parseNoteContent(longTitle);
      expect(result.title.length).toBe(239);
      expect(result.title.endsWith("😀")).toBe(false);
      expect(result.body.startsWith("😀")).toBe(true);
      // The label is only a lookup surface; the remainder still holds every
      // character past it so the content is never split mid-word.
      expect(result.title + result.body).toBe(longTitle);
    });

    // The create→render round-trip must be lossless: `parseNoteContent` and
    // `reconstructNoteContent` are inverses, so no committed record silently
    // gains an injected newline or loses a blank line the user typed (#29003).
    describe("round-trips exactly through reconstructNoteContent", () => {
      const cases: Array<[string, string]> = [
        ["a single line longer than the 240-char label bound", "a".repeat(300)],
        [
          "a blank line placed right after the first line",
          "Meeting\n\nDiscuss roadmap",
        ],
        ["trailing blank lines", "Shopping\nmilk\neggs\n\n"],
        [
          "a multi-paragraph body with internal blank lines",
          "Roadmap\n\nQ1 goals\n\nQ2 goals\n\nQ3 goals",
        ],
        ["a first line of exactly 240 characters", `${"x".repeat(240)}\nbody`],
        ["a first line of exactly 241 characters", `${"y".repeat(241)}\nbody`],
        [
          "a long unwrapped URL on one line",
          `https://example.com/${"p".repeat(300)}`,
        ],
      ];
      for (const [name, original] of cases) {
        it(name, () => {
          const parsed = parseNoteContent(original);
          expect(reconstructNoteContent(parsed)).toBe(original);
          // The stored label stays within the schema's list-label bound even
          // when it is a truncated prefix of a long first line.
          expect(parsed.title.length).toBeLessThanOrEqual(240);
          expect(parsed.title.length).toBeGreaterThan(0);
        });
      }

      it("normalizes CRLF newlines while preserving the split structure", () => {
        const parsed = parseNoteContent("Title\r\n\r\nBody line");
        // The first line's own \r moves into the verbatim remainder, so the
        // label stays clean and concatenation reproduces the CRLF input.
        expect(parsed.title).toBe("Title");
        expect(reconstructNoteContent(parsed)).toBe("Title\r\n\r\nBody line");
      });

      it("reconstructs a short single line as the label alone", () => {
        const parsed = parseNoteContent("Just a title");
        expect(parsed).toEqual({ title: "Just a title", body: "" });
        expect(reconstructNoteContent(parsed)).toBe("Just a title");
      });
    });
  });

  describe("parseEntityId", () => {
    it("accepts valid lowercase alphanumeric IDs", () => {
      expect(parseEntityId("note-123")).toBe("note-123");
      expect(parseEntityId("abc")).toBe("abc");
    });

    it("rejects invalid IDs (uppercase, symbols, starting with number)", () => {
      expect(() => parseEntityId("123note")).toThrow();
      expect(() => parseEntityId("Note-123")).toThrow();
      expect(() => parseEntityId("ab")).toThrow();
      expect(() => parseEntityId("note_123")).toThrow();
    });
  });

  describe("parseStickyColor", () => {
    it("accepts valid sticky colors", () => {
      expect(parseStickyColor("yellow")).toBe("yellow");
      expect(parseStickyColor("green")).toBe("green");
      expect(parseStickyColor("rose")).toBe("rose");
      expect(parseStickyColor("slate")).toBe("slate");
    });

    it("rejects unknown colors", () => {
      expect(() => parseStickyColor("blue")).toThrow();
      expect(() => parseStickyColor(123)).toThrow();
    });
  });

  describe("parseCreateNoteInput", () => {
    it("validates and defaults sticky color to yellow", () => {
      const note = parseCreateNoteInput({ title: "Test Note" });
      expect(note).toEqual({
        title: "Test Note",
        body: "",
        color: "yellow",
      });
    });

    it("accepts custom body and valid color", () => {
      const note = parseCreateNoteInput({
        title: "Task Note",
        body: "Details here",
        color: "rose",
      });
      expect(note).toEqual({
        title: "Task Note",
        body: "Details here",
        color: "rose",
      });
    });

    it("rejects extra unknown keys in create input", () => {
      expect(() =>
        parseCreateNoteInput({ title: "Test", unknownKey: true }),
      ).toThrow();
    });
  });

  describe("parseUpdateNoteInput", () => {
    it("accepts valid partial patch", () => {
      const patch = parseUpdateNoteInput({ title: "Updated Title" });
      expect(patch).toEqual({ title: "Updated Title" });
    });

    it("rejects empty patch", () => {
      expect(() => parseUpdateNoteInput({})).toThrow();
    });
  });

  describe("parseNotesDocument", () => {
    it("validates complete notes document structure", () => {
      const validDoc = {
        schemaVersion: NOTES_SCHEMA_VERSION,
        revision: 1,
        persistedAt: "2026-08-12T12:00:00.000Z",
        notes: [
          {
            id: "note-001",
            title: "First Note",
            body: "Content",
            color: "green",
            createdAt: "2026-08-12T12:00:00.000Z",
            updatedAt: "2026-08-12T12:00:00.000Z",
          },
        ],
      };
      const parsed = parseNotesDocument(validDoc);
      expect(parsed).toEqual(validDoc);
    });

    it("migrates a v1 document so its body reconstructs the retired view output", () => {
      const v1Note = {
        id: "note-001",
        title: "Header Line",
        // v1 stored the remainder without its separator; the retired view
        // rebuilt content as `title + "\n" + body`.
        body: "First paragraph\nSecond paragraph",
        color: "yellow" as const,
        createdAt: "2026-08-12T12:00:00.000Z",
        updatedAt: "2026-08-12T12:00:00.000Z",
      };
      const parsed = parseNotesDocument({
        schemaVersion: NOTES_SCHEMA_VERSION_V1,
        revision: 3,
        persistedAt: "2026-08-12T12:00:00.000Z",
        notes: [v1Note],
      });
      expect(parsed.schemaVersion).toBe(NOTES_SCHEMA_VERSION);
      const migrated = parsed.notes[0];
      if (!migrated) throw new Error("migrated note missing");
      // The leading separator is restored so the v2 reconstruction matches
      // exactly what the v1 view showed, with no re-corruption.
      expect(migrated.body).toBe("\nFirst paragraph\nSecond paragraph");
      expect(reconstructNoteContent(migrated)).toBe(
        `${v1Note.title}\n${v1Note.body}`,
      );
    });

    it("leaves an empty v1 body untouched during migration", () => {
      const parsed = parseNotesDocument({
        schemaVersion: NOTES_SCHEMA_VERSION_V1,
        revision: 1,
        persistedAt: "2026-08-12T12:00:00.000Z",
        notes: [
          {
            id: "note-001",
            title: "Standalone",
            body: "",
            color: "green" as const,
            createdAt: "2026-08-12T12:00:00.000Z",
            updatedAt: "2026-08-12T12:00:00.000Z",
          },
        ],
      });
      expect(parsed.schemaVersion).toBe(NOTES_SCHEMA_VERSION);
      const migrated = parsed.notes[0];
      if (!migrated) throw new Error("migrated note missing");
      expect(migrated.body).toBe("");
      expect(reconstructNoteContent(migrated)).toBe("Standalone");
    });

    it("rejects an unsupported schema version", () => {
      expect(() =>
        parseNotesDocument({
          schemaVersion: 99,
          revision: 0,
          persistedAt: "2026-08-12T12:00:00.000Z",
          notes: [],
        }),
      ).toThrow();
    });

    it("rejects duplicate note IDs in document", () => {
      const docWithDuplicates = {
        schemaVersion: NOTES_SCHEMA_VERSION,
        revision: 1,
        persistedAt: "2026-08-12T12:00:00.000Z",
        notes: [
          {
            id: "note-001",
            title: "First Note",
            body: "",
            color: "yellow",
            createdAt: "2026-08-12T12:00:00.000Z",
            updatedAt: "2026-08-12T12:00:00.000Z",
          },
          {
            id: "note-001",
            title: "Duplicate Note",
            body: "",
            color: "slate",
            createdAt: "2026-08-12T12:00:00.000Z",
            updatedAt: "2026-08-12T12:00:00.000Z",
          },
        ],
      };
      expect(() => parseNotesDocument(docWithDuplicates)).toThrow();
    });
  });
});
