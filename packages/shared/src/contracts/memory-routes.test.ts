import { describe, expect, it } from "vitest";
import {
  PatchMemoryRequestSchema,
  PostMemoryRememberRequestSchema,
} from "./memory-routes.js";

describe("PostMemoryRememberRequestSchema", () => {
  it("trims text", () => {
    expect(
      PostMemoryRememberRequestSchema.parse({ text: "  hello  " }),
    ).toEqual({ text: "hello" });
  });

  it("rejects whitespace-only text", () => {
    expect(() => PostMemoryRememberRequestSchema.parse({ text: " " })).toThrow(
      /text is required/,
    );
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostMemoryRememberRequestSchema.parse({ text: "x", source: "y" }),
    ).toThrow();
  });
});

describe("PatchMemoryRequestSchema", () => {
  it("trims text", () => {
    expect(PatchMemoryRequestSchema.parse({ text: "  hello  " })).toEqual({
      text: "hello",
    });
  });

  it("rejects whitespace-only text", () => {
    expect(() => PatchMemoryRequestSchema.parse({ text: " " })).toThrow(
      /text is required/,
    );
  });

  it("rejects extra fields", () => {
    expect(() =>
      PatchMemoryRequestSchema.parse({ text: "x", embedding: [] }),
    ).toThrow();
  });
});
