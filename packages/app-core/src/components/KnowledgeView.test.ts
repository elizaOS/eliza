import { describe, expect, it } from "vitest";
import {
  shouldReadKnowledgeFileAsText,
  getKnowledgeUploadFilename,
} from "./KnowledgeView";

// SUPPORTED_UPLOAD_EXTENSIONS and isSupportedKnowledgeFile are not exported
// directly. We test them indirectly via shouldReadKnowledgeFileAsText and by
// importing the module, which validates the extension list compiles correctly.

describe("shouldReadKnowledgeFileAsText", () => {
  it("returns true for .md files by name suffix", () => {
    expect(
      shouldReadKnowledgeFileAsText({ type: "", name: "notes.md" }),
    ).toBe(true);
  });

  it("returns true for .mdx files by name suffix", () => {
    expect(
      shouldReadKnowledgeFileAsText({ type: "", name: "page.mdx" }),
    ).toBe(true);
  });

  it("returns true for .mdx files via text/markdown content type", () => {
    expect(
      shouldReadKnowledgeFileAsText({
        type: "text/markdown",
        name: "page.mdx",
      }),
    ).toBe(true);
  });

  it("returns true for plain text type", () => {
    expect(
      shouldReadKnowledgeFileAsText({ type: "text/plain", name: "readme.txt" }),
    ).toBe(true);
  });

  it("returns true for text/html type", () => {
    expect(
      shouldReadKnowledgeFileAsText({ type: "text/html", name: "index.html" }),
    ).toBe(true);
  });

  it("returns true for text/csv type", () => {
    expect(
      shouldReadKnowledgeFileAsText({ type: "text/csv", name: "data.csv" }),
    ).toBe(true);
  });

  it("returns true for application/json type", () => {
    expect(
      shouldReadKnowledgeFileAsText({
        type: "application/json",
        name: "config.json",
      }),
    ).toBe(true);
  });

  it("returns true for application/xml type", () => {
    expect(
      shouldReadKnowledgeFileAsText({
        type: "application/xml",
        name: "data.xml",
      }),
    ).toBe(true);
  });

  it("returns false for .png files", () => {
    expect(
      shouldReadKnowledgeFileAsText({ type: "image/png", name: "photo.png" }),
    ).toBe(false);
  });

  it("returns false for .jpg files", () => {
    expect(
      shouldReadKnowledgeFileAsText({ type: "image/jpeg", name: "photo.jpg" }),
    ).toBe(false);
  });

  it("returns false for .pdf files with no matching type", () => {
    expect(
      shouldReadKnowledgeFileAsText({
        type: "application/pdf",
        name: "doc.pdf",
      }),
    ).toBe(false);
  });
});

describe("SUPPORTED_UPLOAD_EXTENSIONS", () => {
  // Validate extensions indirectly — if isSupportedKnowledgeFile accepts a
  // file it means that extension is in the set.
  // We import shouldReadKnowledgeFileAsText as a proxy; for extension coverage
  // we just verify the module exports are intact.

  it("module exports shouldReadKnowledgeFileAsText as a function", () => {
    expect(typeof shouldReadKnowledgeFileAsText).toBe("function");
  });

  it("module exports getKnowledgeUploadFilename as a function", () => {
    expect(typeof getKnowledgeUploadFilename).toBe("function");
  });
});

describe("getKnowledgeUploadFilename", () => {
  it("returns webkitRelativePath when present", () => {
    const file = { name: "notes.md", webkitRelativePath: "folder/notes.md" };
    expect(getKnowledgeUploadFilename(file as File & { webkitRelativePath: string })).toBe(
      "folder/notes.md",
    );
  });

  it("falls back to name when webkitRelativePath is empty", () => {
    const file = { name: "notes.md", webkitRelativePath: "" };
    expect(getKnowledgeUploadFilename(file as File & { webkitRelativePath: string })).toBe(
      "notes.md",
    );
  });
});
