/**
 * Contract tests for the character-field generation route request schema: the target field enum
 * (bio/system/style/chatExamples/postExamples), append/replace mode, and strict context parsing.
 * Drives the real schema with accept/reject fixtures.
 */
import { describe, expect, it } from "vitest";
import { PostCharacterGenerateRequestSchema } from "./character-routes.js";

describe("PostCharacterGenerateRequestSchema", () => {
  it("accepts a minimal request with bio field", () => {
    const parsed = PostCharacterGenerateRequestSchema.parse({
      field: "bio",
      context: { name: "Eliza" },
    });
    expect(parsed.field).toBe("bio");
    expect(parsed.context.name).toBe("Eliza");
  });

  it("accepts each valid field value", () => {
    for (const field of [
      "bio",
      "system",
      "style",
      "chatExamples",
      "postExamples",
    ] as const) {
      expect(() =>
        PostCharacterGenerateRequestSchema.parse({
          field,
          context: {},
        }),
      ).not.toThrow();
    }
  });

  it("accepts mode append/replace", () => {
    expect(
      PostCharacterGenerateRequestSchema.parse({
        field: "bio",
        context: {},
        mode: "append",
      }).mode,
    ).toBe("append");
    expect(
      PostCharacterGenerateRequestSchema.parse({
        field: "bio",
        context: {},
        mode: "replace",
      }).mode,
    ).toBe("replace");
  });

  it("rejects unknown field", () => {
    expect(() =>
      PostCharacterGenerateRequestSchema.parse({
        field: "intro",
        context: {},
      }),
    ).toThrow();
  });

  it("rejects unknown mode", () => {
    expect(() =>
      PostCharacterGenerateRequestSchema.parse({
        field: "bio",
        context: {},
        mode: "merge",
      }),
    ).toThrow();
  });

  it("rejects extra context fields (strict)", () => {
    expect(() =>
      PostCharacterGenerateRequestSchema.parse({
        field: "bio",
        context: { name: "Eliza", custom: "x" },
      }),
    ).toThrow();
  });

  it("rejects missing field or context", () => {
    expect(() =>
      PostCharacterGenerateRequestSchema.parse({ context: {} }),
    ).toThrow();
    expect(() =>
      PostCharacterGenerateRequestSchema.parse({ field: "bio" }),
    ).toThrow();
  });
});
