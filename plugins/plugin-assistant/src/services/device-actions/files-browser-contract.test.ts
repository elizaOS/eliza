import { describe, expect, it } from "vitest";
import { deviceOperationSupportedByCapabilities } from "./contract.ts";
import {
  describeFilesOperation,
  FILES_CAPABILITY,
  FILES_DIRECT_TYPES,
  FILES_OPERATION_SCHEMAS,
  FILES_OPERATION_TYPES,
  filesContextAllowed,
  filesNeedsIdentity,
  isFilesOperation,
  validateFilesOperation,
} from "./files-browser-contract.ts";

describe("files.browser.v1 operations", () => {
  it("validates one flat shape that validates again unchanged", () => {
    for (const op of [
      { type: "files_filter", text: "lease", kind: "pdf", folder: "Download" },
      { type: "files_filter", from: "2026-10-01", to: "2026-10-31" },
      { type: "files_open", path: "Download/lease.pdf" },
      { type: "files_share", paths: ["Download/a.pdf", "DCIM/Camera/b.jpg"] },
      { type: "files_move", paths: ["Download/a.pdf"], dest: "" },
      { type: "files_trash", paths: ["Download/a.pdf"] },
      { type: "files_folder_create", parent: "Documents", name: "Taxes" },
    ]) {
      const valid = validateFilesOperation(op);
      expect(valid).toEqual(op);
      expect(validateFilesOperation(valid)).toEqual(valid);
    }
  });
  it("carries the reviewed identity of each moved or trashed file", () => {
    const reviewed = ["a".repeat(43), "b".repeat(43)];
    for (const op of [
      {
        type: "files_move",
        paths: ["Download/a.pdf", "Download/Folder"],
        dest: "Documents",
        reviewed,
      },
      {
        type: "files_trash",
        paths: ["Download/a.pdf", "Download/Folder"],
        reviewed,
      },
    ]) {
      const valid = validateFilesOperation(op);
      expect(valid).toEqual(op);
      expect(validateFilesOperation(valid)).toEqual(valid);
    }
    for (const bad of [
      {
        type: "files_trash",
        paths: ["a", "b"],
        reviewed: [{ size: 1, modified: 1 }],
      },
      {
        type: "files_trash",
        paths: ["a"],
        reviewed: [{ size: -1, modified: 1 }],
      },
      {
        type: "files_trash",
        paths: ["a"],
        reviewed: [{ size: 1, modified: 1.5 }],
      },
      {
        type: "files_trash",
        paths: ["a"],
        reviewed: [{ size: 1, modified: 1, path: "a" }],
      },
      { type: "files_move", paths: ["a"], dest: "", reviewed: {} },
      {
        type: "files_share",
        paths: ["a"],
        reviewed: [{ size: 1, modified: 1 }],
      },
    ])
      expect(() => validateFilesOperation(bad)).toThrow();
    expect(filesNeedsIdentity({ type: "files_trash", paths: ["a"] })).toBe(
      true,
    );
    expect(filesNeedsIdentity({ type: "files_share", paths: ["a"] })).toBe(
      false,
    );
    // The agent's tool schema never offers it.
    for (const schema of FILES_OPERATION_SCHEMAS)
      expect(Object.keys(schema.properties ?? {})).not.toContain("reviewed");
  });
  it("rejects escapes, duplicates, hidden folders, empty filters and extra fields", () => {
    for (const bad of [
      { type: "files_trash", paths: ["../etc/passwd"] },
      { type: "files_open", path: "/storage/emulated/0/a" },
      { type: "files_move", paths: [], dest: "x" },
      { type: "files_move", paths: ["a", "a"], dest: "x" },
      { type: "files_folder_create", parent: "", name: ".hidden" },
      { type: "files_filter" },
      { type: "files_filter", from: "2026-11-02", to: "2026-11-01" },
      { type: "files_open", path: "a", extra: 1 },
      { type: "files_delete", paths: ["a"] },
    ])
      expect(() => validateFilesOperation(bad)).toThrow();
  });
  it("runs only filter and open directly; changes need Files on the unlocked screen", () => {
    expect([...FILES_DIRECT_TYPES]).toEqual(["files_filter", "files_open"]);
    expect(
      filesContextAllowed(
        { type: "files_trash", paths: ["a"] },
        { view: "home" },
      ),
    ).toBe(false);
    expect(
      filesContextAllowed(
        { type: "files_trash", paths: ["a"] },
        { view: "files" },
      ),
    ).toBe(true);
    expect(
      filesContextAllowed(
        { type: "files_filter", text: "a" },
        { view: "files", sensitive: true },
      ),
    ).toBe(false);
    expect(
      describeFilesOperation({
        type: "files_move",
        paths: ["Download/a.pdf"],
        dest: "Documents/Taxes",
      }),
    ).toEqual({
      title: "Move 1 item",
      description: "a.pdf → Documents › Taxes",
    });
  });
  it("is advertised only to a phone that negotiated files.browser.v1", () => {
    for (const type of FILES_OPERATION_TYPES) {
      expect(isFilesOperation({ type })).toBe(true);
      expect(
        deviceOperationSupportedByCapabilities(type, [FILES_CAPABILITY]),
      ).toBe(true);
      expect(
        deviceOperationSupportedByCapabilities(type, [
          "camera.capture-photo.v1",
        ]),
      ).toBe(false);
      expect(deviceOperationSupportedByCapabilities(type, undefined)).toBe(
        false,
      );
    }
    expect(
      FILES_OPERATION_SCHEMAS.flatMap(
        (schema) => schema.properties?.type.enum ?? [],
      ),
    ).toEqual([
      "files_filter",
      "files_open",
      "files_share",
      "files_trash",
      "files_move",
      "files_folder_create",
    ]);
  });
});
