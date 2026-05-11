import { describe, expect, it } from "vitest";
import {
  PostRunControlRequestSchema,
  PostRunMessageRequestSchema,
} from "./apps-runs-routes.js";

describe("PostRunMessageRequestSchema", () => {
  it("accepts a content field", () => {
    const parsed = PostRunMessageRequestSchema.parse({ content: "hello" });
    expect(parsed).toEqual({ content: "hello" });
  });

  it("accepts a message alias", () => {
    const parsed = PostRunMessageRequestSchema.parse({ message: "hello" });
    expect(parsed).toEqual({ content: "hello" });
  });

  it("prefers content over message when both are present", () => {
    const parsed = PostRunMessageRequestSchema.parse({
      content: "from content",
      message: "from message",
    });
    expect(parsed).toEqual({ content: "from content" });
  });

  it("trims surrounding whitespace", () => {
    const parsed = PostRunMessageRequestSchema.parse({
      content: "  hello  ",
    });
    expect(parsed).toEqual({ content: "hello" });
  });

  it("rejects empty body", () => {
    expect(() => PostRunMessageRequestSchema.parse({})).toThrow(
      /content is required/,
    );
  });

  it("rejects whitespace-only content", () => {
    expect(() =>
      PostRunMessageRequestSchema.parse({ content: "   " }),
    ).toThrow();
  });

  it("rejects extra fields (strict)", () => {
    expect(() =>
      PostRunMessageRequestSchema.parse({ content: "x", role: "user" }),
    ).toThrow();
  });
});

describe("PostRunControlRequestSchema", () => {
  it("accepts pause", () => {
    const parsed = PostRunControlRequestSchema.parse({ action: "pause" });
    expect(parsed).toEqual({ action: "pause" });
  });

  it("accepts resume", () => {
    const parsed = PostRunControlRequestSchema.parse({ action: "resume" });
    expect(parsed).toEqual({ action: "resume" });
  });

  it("rejects unknown actions", () => {
    expect(() =>
      PostRunControlRequestSchema.parse({ action: "stop" }),
    ).toThrow();
  });

  it("rejects missing action", () => {
    expect(() => PostRunControlRequestSchema.parse({})).toThrow();
  });

  it("rejects non-string action", () => {
    expect(() => PostRunControlRequestSchema.parse({ action: true })).toThrow();
  });

  it("rejects extra fields (strict)", () => {
    expect(() =>
      PostRunControlRequestSchema.parse({ action: "pause", reason: "idle" }),
    ).toThrow();
  });
});
