/**
 * Coverage for documents constants.
 */
import { describe, expect, it } from "vitest";
import { ALLOWED_EXTENSIONS, DOCUMENT_CONSTANTS, isValidFilename } from "./documents.js";

describe("documents", () => {
  it("exposes constants", () => {
    expect(DOCUMENT_CONSTANTS.MAX_FILES_PER_REQUEST).toBe(5);
    expect(ALLOWED_EXTENSIONS).toContain(".pdf");
  });
  it("validates filename", () => {
    expect(isValidFilename("good.pdf")).toBe(true);
    expect(isValidFilename("../evil.pdf")).toBe(false);
    expect(isValidFilename("a/b.txt")).toBe(false);
    expect(isValidFilename("")).toBe(false);
  });
});
