/**
 * Contract tests for the memory route request schemas: remember (create) and
 * patch (edit). Both require a non-blank text field that is trimmed, reject
 * whitespace-only text with the canonical message, and reject unknown fields.
 * Pure in-process schema parsing — no server or mocks.
 */
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

  it("accepts and trims an optional idempotency key", () => {
    expect(
      PostMemoryRememberRequestSchema.parse({
        text: " hello ",
        idempotencyKey: " onboarding:session-a ",
      }),
    ).toEqual({ text: "hello", idempotencyKey: "onboarding:session-a" });
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
