import { describe, expect, it } from "vitest";
import {
  PostCreateAppRequestSchema,
  PostInstallAppRequestSchema,
  PostLaunchAppRequestSchema,
  PostOverlayPresenceRequestSchema,
  PostRelaunchAppRequestSchema,
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

describe("PostRelaunchAppRequestSchema", () => {
  it("accepts name only", () => {
    const parsed = PostRelaunchAppRequestSchema.parse({ name: "companion" });
    expect(parsed).toEqual({ name: "companion" });
  });

  it("accepts name + runId + verify", () => {
    const parsed = PostRelaunchAppRequestSchema.parse({
      name: "companion",
      runId: "run-abc",
      verify: true,
    });
    expect(parsed).toEqual({
      name: "companion",
      runId: "run-abc",
      verify: true,
    });
  });

  it("trims name and runId", () => {
    const parsed = PostRelaunchAppRequestSchema.parse({
      name: "  companion  ",
      runId: "  run-abc  ",
    });
    expect(parsed).toEqual({ name: "companion", runId: "run-abc" });
  });

  it("rejects missing name", () => {
    expect(() =>
      PostRelaunchAppRequestSchema.parse({ runId: "abc" }),
    ).toThrow();
  });

  it("rejects empty name", () => {
    expect(() => PostRelaunchAppRequestSchema.parse({ name: "" })).toThrow();
  });

  it("rejects non-boolean verify", () => {
    expect(() =>
      PostRelaunchAppRequestSchema.parse({ name: "x", verify: "true" }),
    ).toThrow();
  });

  it("rejects extra fields (strict)", () => {
    expect(() =>
      PostRelaunchAppRequestSchema.parse({ name: "x", force: true }),
    ).toThrow();
  });
});

describe("PostCreateAppRequestSchema", () => {
  it("accepts intent only", () => {
    const parsed = PostCreateAppRequestSchema.parse({ intent: "make a todo" });
    expect(parsed).toEqual({ intent: "make a todo" });
  });

  it("accepts intent + editTarget", () => {
    const parsed = PostCreateAppRequestSchema.parse({
      intent: "tweak the colour",
      editTarget: "companion",
    });
    expect(parsed).toEqual({
      intent: "tweak the colour",
      editTarget: "companion",
    });
  });

  it("trims intent and editTarget", () => {
    const parsed = PostCreateAppRequestSchema.parse({
      intent: "  build me an app  ",
      editTarget: "  companion  ",
    });
    expect(parsed).toEqual({
      intent: "build me an app",
      editTarget: "companion",
    });
  });

  it("rejects missing intent", () => {
    expect(() => PostCreateAppRequestSchema.parse({})).toThrow();
  });

  it("rejects empty intent", () => {
    expect(() => PostCreateAppRequestSchema.parse({ intent: "" })).toThrow();
  });

  it("rejects empty editTarget (use omission)", () => {
    expect(() =>
      PostCreateAppRequestSchema.parse({ intent: "x", editTarget: "" }),
    ).toThrow();
  });

  it("rejects extra fields (strict)", () => {
    expect(() =>
      PostCreateAppRequestSchema.parse({ intent: "x", scaffold: "v2" }),
    ).toThrow();
  });
});

describe("PostOverlayPresenceRequestSchema", () => {
  it("accepts a string appName", () => {
    const parsed = PostOverlayPresenceRequestSchema.parse({
      appName: "companion",
    });
    expect(parsed).toEqual({ appName: "companion" });
  });

  it("accepts explicit null", () => {
    const parsed = PostOverlayPresenceRequestSchema.parse({ appName: null });
    expect(parsed).toEqual({ appName: null });
  });

  it("accepts omitted appName as null", () => {
    const parsed = PostOverlayPresenceRequestSchema.parse({});
    expect(parsed).toEqual({ appName: null });
  });

  it("collapses empty string to null", () => {
    const parsed = PostOverlayPresenceRequestSchema.parse({ appName: "" });
    expect(parsed).toEqual({ appName: null });
  });

  it("collapses whitespace-only string to null", () => {
    const parsed = PostOverlayPresenceRequestSchema.parse({
      appName: "   \t  ",
    });
    expect(parsed).toEqual({ appName: null });
  });

  it("trims surrounding whitespace", () => {
    const parsed = PostOverlayPresenceRequestSchema.parse({
      appName: "  companion  ",
    });
    expect(parsed).toEqual({ appName: "companion" });
  });

  it("rejects non-string non-null appName", () => {
    expect(() =>
      PostOverlayPresenceRequestSchema.parse({ appName: 42 }),
    ).toThrow();
  });

  it("rejects extra fields (strict)", () => {
    expect(() =>
      PostOverlayPresenceRequestSchema.parse({ appName: "x", focus: true }),
    ).toThrow();
  });
});
