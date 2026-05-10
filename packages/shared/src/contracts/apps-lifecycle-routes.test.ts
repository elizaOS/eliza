import { describe, expect, it } from "vitest";
import {
  PostInstallAppRequestSchema,
  PostLaunchAppRequestSchema,
  PostStopAppRequestSchema,
} from "./apps-lifecycle-routes.js";

describe("PostLaunchAppRequestSchema", () => {
  it("accepts a non-empty name", () => {
    const parsed = PostLaunchAppRequestSchema.parse({ name: "companion" });
    expect(parsed.name).toBe("companion");
  });

  it("trims whitespace around name", () => {
    const parsed = PostLaunchAppRequestSchema.parse({ name: "  foo  " });
    expect(parsed.name).toBe("foo");
  });

  it("rejects empty name", () => {
    expect(() => PostLaunchAppRequestSchema.parse({ name: "" })).toThrow();
  });

  it("rejects missing name", () => {
    expect(() => PostLaunchAppRequestSchema.parse({})).toThrow();
  });

  it("rejects extra fields (strict)", () => {
    expect(() =>
      PostLaunchAppRequestSchema.parse({ name: "x", extra: 1 }),
    ).toThrow();
  });
});

describe("PostInstallAppRequestSchema", () => {
  it("accepts name only", () => {
    const parsed = PostInstallAppRequestSchema.parse({
      name: "@elizaos/plugin-foo",
    });
    expect(parsed).toEqual({ name: "@elizaos/plugin-foo" });
  });

  it("accepts name + version", () => {
    const parsed = PostInstallAppRequestSchema.parse({
      name: "@elizaos/plugin-foo",
      version: "1.2.3",
    });
    expect(parsed).toEqual({ name: "@elizaos/plugin-foo", version: "1.2.3" });
  });

  it("trims name and version", () => {
    const parsed = PostInstallAppRequestSchema.parse({
      name: "  @elizaos/plugin-foo  ",
      version: " 1.0.0 ",
    });
    expect(parsed).toEqual({ name: "@elizaos/plugin-foo", version: "1.0.0" });
  });

  it("rejects empty name", () => {
    expect(() => PostInstallAppRequestSchema.parse({ name: "" })).toThrow();
  });

  it("rejects empty version (use omission instead)", () => {
    expect(() =>
      PostInstallAppRequestSchema.parse({ name: "x", version: "" }),
    ).toThrow();
  });

  it("rejects extra fields (strict)", () => {
    expect(() =>
      PostInstallAppRequestSchema.parse({ name: "x", channel: "beta" }),
    ).toThrow();
  });
});

describe("PostStopAppRequestSchema", () => {
  it("accepts name only", () => {
    const parsed = PostStopAppRequestSchema.parse({ name: "companion" });
    expect(parsed).toEqual({ name: "companion" });
  });

  it("accepts runId only", () => {
    const parsed = PostStopAppRequestSchema.parse({ runId: "run-abc" });
    expect(parsed).toEqual({ runId: "run-abc" });
  });

  it("accepts both name and runId", () => {
    const parsed = PostStopAppRequestSchema.parse({
      name: "companion",
      runId: "run-abc",
    });
    expect(parsed).toEqual({ name: "companion", runId: "run-abc" });
  });

  it("trims name and runId", () => {
    const parsed = PostStopAppRequestSchema.parse({
      name: "  companion  ",
      runId: "  run-abc  ",
    });
    expect(parsed).toEqual({ name: "companion", runId: "run-abc" });
  });

  it("rejects empty body", () => {
    expect(() => PostStopAppRequestSchema.parse({})).toThrow(/name or runId/);
  });

  it("rejects empty strings (treated as missing)", () => {
    expect(() =>
      PostStopAppRequestSchema.parse({ name: "", runId: "" }),
    ).toThrow();
  });

  it("rejects extra fields (strict)", () => {
    expect(() =>
      PostStopAppRequestSchema.parse({ name: "x", graceful: true }),
    ).toThrow();
  });
});
