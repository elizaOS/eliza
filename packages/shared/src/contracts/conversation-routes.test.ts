import { describe, expect, it } from "vitest";
import {
  PatchConversationRequestSchema,
  PostConversationCleanupEmptyRequestSchema,
  PostConversationRequestSchema,
  PostConversationTruncateRequestSchema,
} from "./conversation-routes.js";

describe("PostConversationRequestSchema", () => {
  it("accepts an empty body", () => {
    expect(PostConversationRequestSchema.parse({})).toEqual({});
  });

  it("accepts full body with metadata", () => {
    const parsed = PostConversationRequestSchema.parse({
      title: "Hello",
      includeGreeting: true,
      lang: "en",
      metadata: { scope: "general", taskId: "t1" },
    });
    expect(parsed.title).toBe("Hello");
    expect(parsed.metadata?.scope).toBe("general");
  });

  it("rejects unknown metadata field", () => {
    expect(() =>
      PostConversationRequestSchema.parse({
        metadata: { scope: "general", custom: 1 },
      }),
    ).toThrow();
  });

  it("rejects extra body fields", () => {
    expect(() =>
      PostConversationRequestSchema.parse({ title: "x", room: "r" }),
    ).toThrow();
  });
});

describe("PostConversationTruncateRequestSchema", () => {
  it("trims messageId and accepts inclusive", () => {
    expect(
      PostConversationTruncateRequestSchema.parse({
        messageId: "  m1  ",
        inclusive: true,
      }),
    ).toEqual({ messageId: "m1", inclusive: true });
  });

  it("works without inclusive", () => {
    expect(
      PostConversationTruncateRequestSchema.parse({ messageId: "m1" }),
    ).toEqual({ messageId: "m1" });
  });

  it("rejects whitespace-only messageId", () => {
    expect(() =>
      PostConversationTruncateRequestSchema.parse({ messageId: " " }),
    ).toThrow(/messageId is required/);
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostConversationTruncateRequestSchema.parse({
        messageId: "m1",
        sweep: true,
      }),
    ).toThrow();
  });
});

describe("PatchConversationRequestSchema", () => {
  it("accepts empty patch", () => {
    expect(PatchConversationRequestSchema.parse({})).toEqual({});
  });

  it("accepts title change", () => {
    expect(PatchConversationRequestSchema.parse({ title: "X" })).toEqual({
      title: "X",
    });
  });

  it("accepts generate flag", () => {
    expect(PatchConversationRequestSchema.parse({ generate: true })).toEqual({
      generate: true,
    });
  });

  it("accepts metadata=null (clears metadata)", () => {
    expect(PatchConversationRequestSchema.parse({ metadata: null })).toEqual({
      metadata: null,
    });
  });

  it("accepts metadata object", () => {
    expect(
      PatchConversationRequestSchema.parse({
        metadata: { workflowName: "x" },
      }),
    ).toEqual({ metadata: { workflowName: "x" } });
  });

  it("rejects extra fields", () => {
    expect(() =>
      PatchConversationRequestSchema.parse({ title: "x", roomId: "r" }),
    ).toThrow();
  });
});

describe("PostConversationCleanupEmptyRequestSchema", () => {
  it("accepts empty body", () => {
    expect(PostConversationCleanupEmptyRequestSchema.parse({})).toEqual({});
  });

  it("trims keepId", () => {
    expect(
      PostConversationCleanupEmptyRequestSchema.parse({ keepId: "  c1  " }),
    ).toEqual({ keepId: "c1" });
  });

  it("absorbs whitespace-only keepId", () => {
    expect(
      PostConversationCleanupEmptyRequestSchema.parse({ keepId: " " }),
    ).toEqual({});
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostConversationCleanupEmptyRequestSchema.parse({
        keepId: "x",
        force: true,
      }),
    ).toThrow();
  });
});
