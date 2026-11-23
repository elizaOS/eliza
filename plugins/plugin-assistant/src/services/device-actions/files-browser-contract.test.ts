import { describe, expect, it } from "vitest";
import { deviceActionForCapabilities, proposeDeviceAction } from "./action.ts";
import {
  deviceOperationFormSupported,
  deviceOperationSupportedByCapabilities,
} from "./contract.ts";
import {
  describeFilesOperation,
  FILES_CAPABILITY,
  FILES_DIRECT_TYPES,
  FILES_OPERATION_SCHEMAS,
  FILES_OPERATION_TYPES,
  FILES_SHOWN_TARGET_CAPABILITY,
  filesContextAllowed,
  filesNeedsIdentity,
  filesShownTarget,
  isFilesOperation,
  validateFilesOperation,
} from "./files-browser-contract.ts";

describe("files.browser.v1 operations", () => {
  it("validates one flat shape that validates again unchanged", () => {
    for (const op of [
      { type: "files_filter", text: "lease", kind: "pdf", folder: "Download" },
      { type: "files_filter", from: "2026-10-01", to: "2026-10-31" },
      { type: "files_open", path: "Download/lease.pdf" },
      { type: "files_open", shown: 2 },
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
      { type: "files_open" },
      { type: "files_open", shown: 0 },
      { type: "files_open", shown: 1.5 },
      { type: "files_open", shown: 1, path: "a" },
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
      // The same three by shown positions (files.shown-target.v1).
      "files_share",
      "files_trash",
      "files_move",
      "files_folder_create",
    ]);
  });
  it("names files to share, move or trash by their shown positions", () => {
    for (const op of [
      { type: "files_share", shown: [1, 3] },
      { type: "files_move", shown: [2], dest: "Documents" },
      { type: "files_trash", shown: [1] },
    ]) {
      const valid = validateFilesOperation(op);
      expect(valid).toEqual(op);
      expect(validateFilesOperation(valid)).toEqual(valid);
      expect(filesShownTarget(valid)).toBe(true);
      // Identities bind only after the phone resolves the positions to paths.
      expect(filesNeedsIdentity(valid)).toBe(false);
      expect(deviceOperationFormSupported(valid, [FILES_CAPABILITY])).toBe(
        false,
      );
      expect(
        deviceOperationFormSupported(valid, [
          FILES_CAPABILITY,
          FILES_SHOWN_TARGET_CAPABILITY,
        ]),
      ).toBe(true);
    }
    expect(
      deviceOperationFormSupported({ type: "files_trash", paths: ["a"] }, [
        FILES_CAPABILITY,
      ]),
    ).toBe(true);
    expect(filesShownTarget({ type: "files_open", shown: 1 })).toBe(false);
    for (const bad of [
      { type: "files_share", shown: [] },
      { type: "files_share", shown: [0] },
      { type: "files_share", shown: [1, 1] },
      { type: "files_share", shown: 1 },
      { type: "files_share", shown: [1], paths: ["a"] },
      { type: "files_trash", shown: [1], reviewed: ["a".repeat(43)] },
      { type: "files_move", shown: [1] },
      { type: "files_folder_create", parent: "", name: "a", shown: [1] },
    ])
      expect(() => validateFilesOperation(bad)).toThrow();
    expect(
      describeFilesOperation({ type: "files_trash", shown: [1, 2] }),
    ).toEqual({
      title: "Move 2 items to Trash",
      description: "Items 1, 2 in the results shown",
    });
  });
  it("offers shown positions on a share, move or trash only with files.shown-target.v1", () => {
    const shownTypes = (capabilities: string[]) =>
      (
        deviceActionForCapabilities(
          proposeDeviceAction,
          capabilities,
        ).parameters?.find((parameter) => parameter.name === "operation")
          ?.schema.anyOf ?? []
      )
        .filter((branch) => branch.properties?.shown)
        .flatMap((branch) => branch.properties?.type?.enum ?? []);
    expect(shownTypes([FILES_CAPABILITY])).toEqual(["files_open"]);
    expect(
      shownTypes([FILES_CAPABILITY, FILES_SHOWN_TARGET_CAPABILITY]),
    ).toEqual(["files_open", "files_share", "files_trash", "files_move"]);
  });
});
