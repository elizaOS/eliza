import { describe, it, expect } from "vitest";
import {
  extractTextFromPrompt,
  extractAttachmentsFromPrompt,
  formatToolTitle,
  inferToolKind,
} from "../src/event-mapper.js";

describe("extractTextFromPrompt", () => {
  it("should extract text from text blocks", () => {
    const prompt = [
      { type: "text" as const, text: "Hello" },
      { type: "text" as const, text: "World" },
    ];
    expect(extractTextFromPrompt(prompt)).toBe("Hello\nWorld");
  });

  it("should handle empty prompt", () => {
    expect(extractTextFromPrompt([])).toBe("");
  });
});

describe("extractAttachmentsFromPrompt", () => {
  it("should extract image attachments", () => {
    const prompt = [
      {
        type: "image" as const,
        data: "base64data",
        mimeType: "image/png",
      },
    ];
    const attachments = extractAttachmentsFromPrompt(prompt);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toEqual({
      type: "image",
      mimeType: "image/png",
      content: "base64data",
    });
  });

  it("should skip images without data or mimeType", () => {
    const prompt = [
      { type: "image" as const, data: undefined, mimeType: "image/png" },
      { type: "image" as const, data: "base64data", mimeType: undefined },
    ];
    expect(extractAttachmentsFromPrompt(prompt)).toHaveLength(0);
  });
});

describe("formatToolTitle", () => {
  it("should return tool name when no args", () => {
    expect(formatToolTitle("readFile", undefined)).toBe("readFile");
    expect(formatToolTitle("readFile", {})).toBe("readFile");
  });

  it("should format tool with args", () => {
    expect(formatToolTitle("readFile", { path: "/test.txt" })).toBe(
      "readFile: path: /test.txt"
    );
  });

  it("should truncate long values", () => {
    const longValue = "a".repeat(150);
    const result = formatToolTitle("test", { data: longValue });
    expect(result.length).toBeLessThan(200);
    expect(result).toContain("...");
  });

  it("should use 'tool' as default name", () => {
    expect(formatToolTitle(undefined, undefined)).toBe("tool");
  });
});

describe("inferToolKind", () => {
  it("should infer read tools", () => {
    expect(inferToolKind("readFile")).toBe("read");
    expect(inferToolKind("ReadDocument")).toBe("read");
  });

  it("should infer write/edit tools", () => {
    expect(inferToolKind("writeFile")).toBe("edit");
    expect(inferToolKind("editDocument")).toBe("edit");
  });

  it("should infer delete tools", () => {
    expect(inferToolKind("deleteFile")).toBe("delete");
    expect(inferToolKind("removeItem")).toBe("delete");
  });

  it("should infer move tools", () => {
    expect(inferToolKind("moveFile")).toBe("move");
    expect(inferToolKind("renameDocument")).toBe("move");
  });

  it("should infer search tools", () => {
    expect(inferToolKind("searchCode")).toBe("search");
    expect(inferToolKind("findFiles")).toBe("search");
  });

  it("should infer execute tools", () => {
    expect(inferToolKind("execCommand")).toBe("execute");
    expect(inferToolKind("runScript")).toBe("execute");
    expect(inferToolKind("bash")).toBe("execute");
  });

  it("should infer fetch tools", () => {
    expect(inferToolKind("fetchUrl")).toBe("fetch");
    expect(inferToolKind("httpRequest")).toBe("fetch");
  });

  it("should return other for unknown tools", () => {
    expect(inferToolKind("customTool")).toBe("other");
    expect(inferToolKind(undefined)).toBe("other");
  });
});
