/**
 * Contract tests for the device-pairing auth route Zod schemas: the pair request (non-empty
 * code) and the pair response (token). Exercises strict parsing and accept/reject cases against
 * the real schemas.
 */
import { describe, expect, it } from "vitest";
import {
  PostAuthPairRequestSchema,
  PostAuthPairResponseSchema,
} from "./auth-routes.js";

describe("PostAuthPairRequestSchema", () => {
  it("accepts a non-empty code", () => {
    expect(PostAuthPairRequestSchema.parse({ code: "ABC123" })).toEqual({
      code: "ABC123",
    });
  });

  it("rejects an empty code", () => {
    expect(() => PostAuthPairRequestSchema.parse({ code: "" })).toThrow(
      /required/,
    );
  });

  it("rejects a missing code", () => {
    expect(() => PostAuthPairRequestSchema.parse({})).toThrow();
  });

  it("rejects a non-string code", () => {
    expect(() => PostAuthPairRequestSchema.parse({ code: 123 })).toThrow();
  });

  it("rejects extra fields (strict)", () => {
    expect(() =>
      PostAuthPairRequestSchema.parse({ code: "ABC", remember: true }),
    ).toThrow();
  });
});

describe("PostAuthPairResponseSchema", () => {
  it("accepts a token", () => {
    expect(PostAuthPairResponseSchema.parse({ token: "tok-1" })).toEqual({
      token: "tok-1",
    });
  });

  it("rejects a non-string token", () => {
    expect(() => PostAuthPairResponseSchema.parse({ token: 123 })).toThrow();
  });

  it("rejects extra fields (strict)", () => {
    expect(() =>
      PostAuthPairResponseSchema.parse({ token: "tok-1", expiresAt: 0 }),
    ).toThrow();
  });
});
