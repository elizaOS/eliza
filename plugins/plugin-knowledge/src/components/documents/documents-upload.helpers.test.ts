/**
 * Unit tests for documents upload helpers: validates upload constraints and file type predicates.
 */
import { describe, expect, it } from "vitest";
import {
  isSupportedDocumentFile,
  shouldReadDocumentFileAsText,
} from "./documents-upload.helpers.ts";

describe("documents-upload.helpers", () => {
  it("detects supported document extensions", () => {
    expect(isSupportedDocumentFile({ name: "report.pdf" })).toBe(true);
    expect(isSupportedDocumentFile({ name: "notes.MD" })).toBe(true);
    expect(isSupportedDocumentFile({ name: "app.exe" })).toBe(false);
  });

  it("determines whether file should be read as text", () => {
    expect(shouldReadDocumentFileAsText({ name: "notes.md", type: "" })).toBe(
      true,
    );
    expect(
      shouldReadDocumentFileAsText({
        name: "data.json",
        type: "application/json",
      }),
    ).toBe(true);
    expect(
      shouldReadDocumentFileAsText({ name: "photo.jpg", type: "image/jpeg" }),
    ).toBe(false);
  });

  it("reads uppercase markdown with an empty MIME type as text", () => {
    // Desktop pickers commonly leave markdown untyped; Windows keeps .MD.
    // The support check already lowercases, so README.MD is accepted and then
    // must take the UTF-8 text path instead of being base64-encoded.
    expect(shouldReadDocumentFileAsText({ name: "README.MD", type: "" })).toBe(
      true,
    );
    expect(shouldReadDocumentFileAsText({ name: "Notes.Mdx", type: "" })).toBe(
      true,
    );
  });

  it.each([
    ["notes.txt", ""],
    ["NOTES.TXT", ""],
    ["export.csv", "application/vnd.ms-excel"],
    ["data.xml", "text/xml"],
    ["data.json", ""],
  ] as const)(
    "reads %s with MIME %j as text instead of base64",
    (name, type) => {
      // The server already treats these filenames as UTF-8 text-backed. If the
      // picker leaves MIME empty (or Windows labels CSV as Excel), the client
      // still has to take readAsText so search stores the file, not its base64.
      expect(shouldReadDocumentFileAsText({ name, type })).toBe(true);
    },
  );
});
