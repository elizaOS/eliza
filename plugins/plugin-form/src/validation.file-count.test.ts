/** A one-file field must say "1 file", not "1 files". */
import { describe, expect, it } from "vitest";
import type { FormControl } from "./types";
import { validateField } from "./validation";

function file(id: string) {
  return {
    id,
    name: `${id}.pdf`,
    mimeType: "application/pdf",
    size: 42,
    url: `https://files.example/${id}.pdf`,
  };
}

function fileControl(maxFiles: number): FormControl {
  return {
    key: "document",
    label: "Document",
    type: "file",
    file: { maxFiles },
  };
}

describe("validateField file count", () => {
  it("says 1 file when a one-file field receives two files", () => {
    const result = validateField([file("a"), file("b")], fileControl(1));
    expect(result).toEqual({
      valid: false,
      error: "Maximum 1 file allowed",
    });
  });

  it("keeps the plural when the limit is 2", () => {
    const result = validateField(
      [file("a"), file("b"), file("c")],
      fileControl(2),
    );
    expect(result).toEqual({
      valid: false,
      error: "Maximum 2 files allowed",
    });
  });

  it("accepts a single file on a one-file field", () => {
    expect(validateField([file("a")], fileControl(1)).valid).toBe(true);
  });
});
