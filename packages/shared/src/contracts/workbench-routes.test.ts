import { describe, expect, it } from "vitest";
import {
  PostWorkbenchTodoCompleteRequestSchema,
  PostWorkbenchTodoRequestSchema,
  PutWorkbenchTodoRequestSchema,
} from "./workbench-routes.js";

describe("PostWorkbenchTodoRequestSchema", () => {
  it("trims name and accepts a minimal body", () => {
    expect(
      PostWorkbenchTodoRequestSchema.parse({ name: "  Pay bills  " }),
    ).toEqual({ name: "Pay bills" });
  });

  it("accepts a full body with priority/tags/etc", () => {
    const parsed = PostWorkbenchTodoRequestSchema.parse({
      name: "Buy milk",
      description: "From the corner store",
      priority: 3,
      isUrgent: true,
      type: "errand",
      isCompleted: false,
      tags: ["food", "today"],
    });
    expect(parsed.priority).toBe(3);
    expect(parsed.tags).toEqual(["food", "today"]);
  });

  it("accepts priority as string and null", () => {
    expect(
      PostWorkbenchTodoRequestSchema.parse({ name: "x", priority: "high" })
        .priority,
    ).toBe("high");
    expect(
      PostWorkbenchTodoRequestSchema.parse({ name: "x", priority: null })
        .priority,
    ).toBe(null);
  });

  it("rejects whitespace-only name", () => {
    expect(() => PostWorkbenchTodoRequestSchema.parse({ name: " " })).toThrow(
      /name is required/,
    );
  });

  it("rejects missing name", () => {
    expect(() => PostWorkbenchTodoRequestSchema.parse({})).toThrow();
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostWorkbenchTodoRequestSchema.parse({ name: "x", project: "y" }),
    ).toThrow();
  });
});

describe("PostWorkbenchTodoCompleteRequestSchema", () => {
  it("accepts empty body", () => {
    expect(PostWorkbenchTodoCompleteRequestSchema.parse({})).toEqual({});
  });

  it("accepts isCompleted=true", () => {
    expect(
      PostWorkbenchTodoCompleteRequestSchema.parse({ isCompleted: true }),
    ).toEqual({ isCompleted: true });
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostWorkbenchTodoCompleteRequestSchema.parse({
        isCompleted: true,
        force: true,
      }),
    ).toThrow();
  });
});

describe("PutWorkbenchTodoRequestSchema", () => {
  it("accepts empty patch", () => {
    expect(PutWorkbenchTodoRequestSchema.parse({})).toEqual({});
  });

  it("accepts partial updates", () => {
    expect(
      PutWorkbenchTodoRequestSchema.parse({ description: "x", priority: 1 }),
    ).toEqual({ description: "x", priority: 1 });
  });

  it("rejects extra fields", () => {
    expect(() =>
      PutWorkbenchTodoRequestSchema.parse({
        name: "x",
        project: "y",
      }),
    ).toThrow();
  });
});
