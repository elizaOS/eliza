import { readFileSync } from "node:fs";
import { NOTES_LIST_FILTER_CAPABILITY } from "@elizaos/contracts";
import { describe, expect, it } from "vitest";
import {
  deviceOperationSupportedByCapabilities,
  validateDeviceOperation,
} from "./contract";
import {
  describeNotesOrganizeOperation,
  isNotesOrganizeOperation,
  NOTES_ORGANIZE_CAPABILITY,
  NOTES_ORGANIZE_DIRECT_TYPES,
  NOTES_ORGANIZE_TYPES,
  notesFolderName,
  notesOrganizeContextAllowed,
  validateNotesOrganizeOperation,
} from "./notes-organize-contract";

const target = {
  sourceId: "local",
  sourceRevision: "a".repeat(64),
  noteId: "n-1",
  revision: "b".repeat(64),
};
const valid = validateNotesOrganizeOperation;
const invalid = (value: unknown) => () => validateNotesOrganizeOperation(value);

describe("notes organize contract", () => {
  it("carries no product name", () => {
    const source = readFileSync(
      new URL("./notes-organize-contract.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/Alpha/);
  });

  it("recognises exactly the organise operation types", () => {
    expect([...NOTES_ORGANIZE_TYPES]).toEqual([
      "notes_filter",
      "notes_list_filter",
      "notes_move",
      "notes_folder_create",
      "notes_restore",
      "notes_record",
    ]);
    expect([...NOTES_ORGANIZE_DIRECT_TYPES]).toEqual([
      "notes_filter",
      "notes_list_filter",
      "notes_record",
    ]);
    for (const type of NOTES_ORGANIZE_TYPES)
      expect(isNotesOrganizeOperation({ type })).toBe(true);
    for (const type of ["notes_update", "notes_delete", "notes_query", "x"])
      expect(isNotesOrganizeOperation({ type })).toBe(false);
    expect(isNotesOrganizeOperation(null)).toBe(false);
    expect(() => valid({ type: "notes_rename" })).toThrow(
      "Unsupported Notes operation",
    );
    expect(invalid([])).toThrow("Invalid Notes operation");
  });

  it("validates notes_filter", () => {
    expect(valid({ type: "notes_filter", text: "  milk  " })).toEqual({
      type: "notes_filter",
      text: "milk",
    });
    expect(
      valid({ type: "notes_filter", folder: " Work   trips ", kind: "list" }),
    ).toEqual({ type: "notes_filter", folder: "Work trips", kind: "list" });
    for (const kind of ["text", "list", "voice", "link"])
      expect(valid({ type: "notes_filter", kind })).toEqual({
        type: "notes_filter",
        kind,
      });
    expect(valid({ type: "notes_filter", text: "x".repeat(200) })).toEqual({
      type: "notes_filter",
      text: "x".repeat(200),
    });
    expect(invalid({ type: "notes_filter" })).toThrow("Empty Notes filter");
    expect(invalid({ type: "notes_filter", text: "x".repeat(201) })).toThrow(
      "Invalid Notes text",
    );
    expect(invalid({ type: "notes_filter", text: "   " })).toThrow(
      "Invalid Notes text",
    );
    expect(invalid({ type: "notes_filter", text: "a\0b" })).toThrow(
      "Invalid Notes text",
    );
    expect(invalid({ type: "notes_filter", text: 3 })).toThrow(
      "Invalid Notes text",
    );
    expect(invalid({ type: "notes_filter", kind: "image" })).toThrow(
      "Invalid note kind",
    );
    expect(invalid({ type: "notes_filter", folder: "" })).toThrow(
      "Invalid folder name",
    );
    expect(invalid({ type: "notes_filter", text: "a", limit: 5 })).toThrow(
      "Unexpected Notes field",
    );
  });

  it("admits only text and kind on the canonical list capability", () => {
    expect(
      valid({ type: "notes_list_filter", text: " milk ", kind: "list" }),
    ).toEqual({
      type: "notes_list_filter",
      text: "milk",
      kind: "list",
    });
    for (const operation of [
      { type: "notes_list_filter" },
      { type: "notes_list_filter", folder: "Work", kind: "list" },
      { type: "notes_list_filter", kind: "list", noteId: "n-1" },
    ])
      expect(invalid(operation)).toThrow();
    for (const type of NOTES_ORGANIZE_TYPES)
      expect(
        deviceOperationSupportedByCapabilities(type, [
          NOTES_LIST_FILTER_CAPABILITY,
        ]),
      ).toBe(type === "notes_list_filter");
  });

  it("validates folder names without truncating", () => {
    expect(notesFolderName("a".repeat(40))).toBe("a".repeat(40));
    expect(notesFolderName(" a \n\t b ")).toBe("a b");
    for (const value of ["a".repeat(41), " \n ", "a\0", 7, null])
      expect(() => notesFolderName(value)).toThrow("Invalid folder name");
  });

  it("validates notes_move", () => {
    expect(valid({ type: "notes_move", target, folder: " Work " })).toEqual({
      type: "notes_move",
      target,
      folder: "Work",
    });
    expect(valid({ type: "notes_move", target, folder: null })).toEqual({
      type: "notes_move",
      target,
      folder: null,
    });
    expect(invalid({ type: "notes_move", target })).toThrow("Missing folder");
    expect(invalid({ type: "notes_move", target, folder: undefined })).toThrow(
      "Invalid folder name",
    );
    expect(
      invalid({ type: "notes_move", target, folder: "x".repeat(41) }),
    ).toThrow("Invalid folder name");
    expect(
      invalid({ type: "notes_move", target, folder: "Work", note: "n-1" }),
    ).toThrow("Unexpected Notes field");
    expect(
      invalid({
        type: "notes_move",
        target: { ...target, revision: "guess" },
        folder: "Work",
      }),
    ).toThrow("Invalid Notes revision");
    expect(
      invalid({
        type: "notes_move",
        target: { ...target, extra: 1 },
        folder: "Work",
      }),
    ).toThrow("Unexpected Notes fields");
    expect(
      invalid({ type: "notes_move", target: "n-1", folder: "Work" }),
    ).toThrow("Invalid Notes object");
  });

  it("validates notes_folder_create", () => {
    expect(valid({ type: "notes_folder_create", name: "  Recipes " })).toEqual({
      type: "notes_folder_create",
      name: "Recipes",
    });
    expect(invalid({ type: "notes_folder_create" })).toThrow(
      "Invalid folder name",
    );
    expect(
      invalid({ type: "notes_folder_create", name: "x".repeat(41) }),
    ).toThrow("Invalid folder name");
    expect(
      invalid({ type: "notes_folder_create", name: "A", id: "f-1" }),
    ).toThrow("Unexpected Notes field");
  });

  it("validates notes_restore", () => {
    expect(valid({ type: "notes_restore", noteId: "n-1.a:b_c" })).toEqual({
      type: "notes_restore",
      noteId: "n-1.a:b_c",
    });
    for (const noteId of ["", "-n", "a b", "x".repeat(129), "../n", 1])
      expect(invalid({ type: "notes_restore", noteId })).toThrow();
    expect(
      invalid({ type: "notes_restore", noteId: "n-1", entryId: "e" }),
    ).toThrow("Unexpected Notes field");
  });

  it("validates notes_record", () => {
    expect(valid({ type: "notes_record", action: "start" })).toEqual({
      type: "notes_record",
      action: "start",
    });
    expect(valid({ type: "notes_record", action: "stop" })).toEqual({
      type: "notes_record",
      action: "stop",
    });
    for (const action of [undefined, "pause", "START", true])
      expect(invalid({ type: "notes_record", action })).toThrow(
        "Invalid recording action",
      );
    expect(
      invalid({ type: "notes_record", action: "start", title: "Memo" }),
    ).toThrow("Unexpected Notes field");
  });

  it("is admitted by the device contract and wraps its errors", () => {
    expect(
      validateDeviceOperation({ type: "notes_move", target, folder: null }),
    ).toEqual({ type: "notes_move", target, folder: null });
    expect(
      validateDeviceOperation({ type: "notes_record", action: "stop" }),
    ).toEqual({ type: "notes_record", action: "stop" });
    expect(() =>
      validateDeviceOperation({ type: "notes_filter", text: "" }),
    ).toThrow("Invalid Notes operation: Invalid Notes text");
  });

  it("is offered only when the phone negotiated notes.organize.v1", () => {
    expect(NOTES_ORGANIZE_CAPABILITY).toBe("notes.organize.v1");
    const full = ["notes.local-record.v1", NOTES_ORGANIZE_CAPABILITY];
    for (const type of NOTES_ORGANIZE_TYPES) {
      expect(deviceOperationSupportedByCapabilities(type, full)).toBe(
        type !== "notes_list_filter",
      );
      expect(
        deviceOperationSupportedByCapabilities(type, ["notes.local-record.v1"]),
      ).toBe(false);
      expect(
        deviceOperationSupportedByCapabilities(type, [
          NOTES_ORGANIZE_CAPABILITY,
        ]),
      ).toBe(false);
      expect(deviceOperationSupportedByCapabilities(type, [])).toBe(false);
      expect(deviceOperationSupportedByCapabilities(type, undefined)).toBe(
        false,
      );
    }
    // The capability does not widen unrelated operations.
    expect(deviceOperationSupportedByCapabilities("notes_query", full)).toBe(
      false,
    );
  });

  it("describes each change for the review card", () => {
    const d = describeNotesOrganizeOperation;
    expect(d({ type: "notes_filter", text: "milk" })).toEqual({
      title: "Show notes",
      description: "“milk”",
    });
    expect(
      d({ type: "notes_filter", text: "milk", kind: "voice", folder: "Home" }),
    ).toEqual({
      title: "Show notes",
      description: "“milk” · Voice notes · In Home",
    });
    expect(d({ type: "notes_filter", kind: "list" }).description).toBe(
      "Checklists",
    );
    expect(d({ type: "notes_move", target, folder: "Work" })).toEqual({
      title: "Move note",
      description: "To Work",
    });
    expect(d({ type: "notes_move", target, folder: null })).toEqual({
      title: "Move note",
      description: "To no folder",
    });
    expect(d({ type: "notes_folder_create", name: "Recipes" })).toEqual({
      title: "New folder",
      description: "Recipes",
    });
    expect(d({ type: "notes_restore", noteId: "n-1" })).toEqual({
      title: "Restore note",
      description: "From Recently deleted",
    });
    expect(d({ type: "notes_record", action: "start" }).title).toBe(
      "Record voice note",
    );
    expect(d({ type: "notes_record", action: "stop" }).title).toBe(
      "Stop recording",
    );
  });

  it("allows review only on the unlocked phone in Home or Notes, recording only in Notes", () => {
    const move = { type: "notes_move" } as const;
    const record = { type: "notes_record" } as const;
    expect(notesOrganizeContextAllowed({ view: "home" }, move)).toBe(true);
    expect(notesOrganizeContextAllowed({ view: "notes" }, move)).toBe(true);
    expect(notesOrganizeContextAllowed({ view: "calendar" }, move)).toBe(false);
    expect(
      notesOrganizeContextAllowed({ view: "notes", sensitive: true }, move),
    ).toBe(false);
    expect(notesOrganizeContextAllowed({ view: "notes" }, record)).toBe(true);
    expect(notesOrganizeContextAllowed({ view: "home" }, record)).toBe(false);
  });
});
