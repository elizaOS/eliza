/**
 * Unit tests for documents upload helpers: validates upload constraints and file type predicates.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOCUMENT_UPLOAD_SCOPE,
  DOCUMENT_UPLOAD_ACCEPT,
  isSupportedDocumentFile,
  MAX_UPLOAD_REQUEST_BYTES,
  SUPPORTED_UPLOAD_EXTENSIONS,
  shouldReadDocumentFileAsText,
} from "./documents-upload.helpers.ts";

describe("documents-upload.helpers", () => {
  it("exports upload byte budgets and scope defaults", () => {
    expect(MAX_UPLOAD_REQUEST_BYTES).toBe(32 * 1_048_576);
    expect(DEFAULT_DOCUMENT_UPLOAD_SCOPE).toBe("user-private");
    expect(DOCUMENT_UPLOAD_ACCEPT).toContain(".pdf");
    expect(DOCUMENT_UPLOAD_ACCEPT).toContain(".md");
  });

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
});
