/**
 * Exercises app lifecycle request and response parsers with deterministic payloads.
 * Complete results retain normalization and optional fields; invalid inputs remain
 * separate cases for strict boundaries and discriminated install outcomes.
 */
import { describe, expect, it } from "vitest";
import {
  InstallProgressEventSchema,
  PostCreateAppRequestSchema,
  PostCreateAppResponseSchema,
  PostInstallAppRequestSchema,
  PostInstallAppResponseSchema,
  PostLaunchAppRequestSchema,
  PostOverlayPresenceRequestSchema,
  PostOverlayPresenceResponseSchema,
  PostRefreshAppsResponseSchema,
  PostRelaunchAppRequestSchema,
  PostStopAppRequestSchema,
} from "./apps-lifecycle-routes.js";

describe("app launch", () => {
  it("normalizes the name", () => {
    expect(PostLaunchAppRequestSchema.parse({ name: "  companion  " })).toEqual(
      { name: "companion" },
    );
  });
  it.each([{}, { name: "" }, { name: "x", extra: 1 }])(
    "rejects %j",
    (input) => {
      expect(() => PostLaunchAppRequestSchema.parse(input)).toThrow();
    },
  );
});

describe("app install request", () => {
  it("preserves an omitted version", () => {
    expect(
      PostInstallAppRequestSchema.parse({ name: "@elizaos/plugin-foo" }),
    ).toEqual({ name: "@elizaos/plugin-foo" });
  });
  it("normalizes name and version", () => {
    expect(
      PostInstallAppRequestSchema.parse({
        name: "  @elizaos/plugin-foo  ",
        version: " 1.2.3 ",
      }),
    ).toEqual({ name: "@elizaos/plugin-foo", version: "1.2.3" });
  });
  it.each([
    { name: "" },
    { name: "x", version: "" },
    { name: "x", channel: "beta" },
  ])("rejects %j", (input) => {
    expect(() => PostInstallAppRequestSchema.parse(input)).toThrow();
  });
});

describe("app stop", () => {
  it.each([{ name: "companion" }, { runId: "run-abc" }])(
    "accepts either identity: %j",
    (input) => {
      expect(PostStopAppRequestSchema.parse(input)).toEqual(input);
    },
  );
  it("normalizes both identities without losing either", () => {
    expect(
      PostStopAppRequestSchema.parse({
        name: " companion ",
        runId: " run-abc ",
      }),
    ).toEqual({ name: "companion", runId: "run-abc" });
  });
  it("requires an identity", () => {
    expect(() => PostStopAppRequestSchema.parse({})).toThrow(/name or runId/);
  });
  it.each([
    { name: "", runId: "" },
    { name: "x", graceful: true },
  ])("rejects %j", (input) => {
    expect(() => PostStopAppRequestSchema.parse(input)).toThrow();
  });
});

describe("app relaunch", () => {
  it("preserves omitted optional fields", () => {
    expect(PostRelaunchAppRequestSchema.parse({ name: "companion" })).toEqual({
      name: "companion",
    });
  });
  it("normalizes identities and preserves verification", () => {
    expect(
      PostRelaunchAppRequestSchema.parse({
        name: " companion ",
        runId: " run-abc ",
        verify: true,
      }),
    ).toEqual({ name: "companion", runId: "run-abc", verify: true });
  });
  it.each([
    { runId: "abc" },
    { name: "" },
    { name: "x", verify: "true" },
    { name: "x", force: true },
  ])("rejects %j", (input) => {
    expect(() => PostRelaunchAppRequestSchema.parse(input)).toThrow();
  });
});

describe("app create request", () => {
  it("preserves an omitted edit target", () => {
    expect(PostCreateAppRequestSchema.parse({ intent: "make a todo" })).toEqual(
      { intent: "make a todo" },
    );
  });
  it("normalizes intent and edit target", () => {
    expect(
      PostCreateAppRequestSchema.parse({
        intent: " build me an app ",
        editTarget: " companion ",
      }),
    ).toEqual({ intent: "build me an app", editTarget: "companion" });
  });
  it.each([
    {},
    { intent: "" },
    { intent: "x", editTarget: "" },
    { intent: "x", scaffold: "v2" },
  ])("rejects %j", (input) => {
    expect(() => PostCreateAppRequestSchema.parse(input)).toThrow();
  });
});

describe("overlay presence", () => {
  it("normalizes the visible app", () => {
    expect(
      PostOverlayPresenceRequestSchema.parse({ appName: " companion " }),
    ).toEqual({ appName: "companion" });
  });
  it.each([{}, { appName: null }, { appName: "" }, { appName: " \t " }])(
    "clears presence for %j",
    (input) => {
      expect(PostOverlayPresenceRequestSchema.parse(input)).toEqual({
        appName: null,
      });
    },
  );
  it.each([{ appName: 42 }, { appName: "x", focus: true }])(
    "rejects request %j",
    (input) => {
      expect(() => PostOverlayPresenceRequestSchema.parse(input)).toThrow();
    },
  );
  it.each(["companion", null])("preserves response app %j", (appName) => {
    const response = { ok: true, appName };
    expect(PostOverlayPresenceResponseSchema.parse(response)).toEqual(response);
  });
  it.each([
    { ok: false, appName: null },
    { ok: true, appName: "" },
    { ok: true, appName: null, focus: true },
  ])("rejects response %j", (input) => {
    expect(() => PostOverlayPresenceResponseSchema.parse(input)).toThrow();
  });
});

describe("app create response", () => {
  const success = {
    success: true,
    text: "App scaffolded.",
    messages: ["copied template", "wrote SCAFFOLD.md"],
    data: { appName: "companion" },
  };
  it.each([
    success,
    { success: false, text: "verification failed", messages: [], data: null },
  ])("preserves the complete result: %j", (response) => {
    expect(PostCreateAppResponseSchema.parse(response)).toEqual(response);
  });
  it.each([
    { text: "x", messages: [], data: null },
    { ...success, messages: "not-an-array" },
    { ...success, runId: "r" },
  ])("rejects %j", (input) => {
    expect(() => PostCreateAppResponseSchema.parse(input)).toThrow();
  });
});

describe("app refresh", () => {
  it.each([0, 12])("preserves count %s", (count) => {
    expect(PostRefreshAppsResponseSchema.parse({ ok: true, count })).toEqual({
      ok: true,
      count,
    });
  });
  it.each([
    { ok: true, count: -1 },
    { ok: true, count: 1.5 },
    { ok: false, count: 0 },
    { ok: true, count: 1, elapsedMs: 100 },
  ])("rejects %j", (input) => {
    expect(() => PostRefreshAppsResponseSchema.parse(input)).toThrow();
  });
});

describe("app install response", () => {
  const success = {
    success: true,
    pluginName: "@elizaos/plugin-foo",
    version: "1.2.3",
    installPath: "/some/path",
    requiresRestart: false,
    progress: [
      { phase: "download", message: "ok" },
      {
        phase: "register",
        message: "ready",
        pluginName: "@elizaos/plugin-foo",
      },
    ],
  };
  const failure = {
    success: false,
    error: "boom",
    progress: [{ phase: "download", message: "started" }],
  };
  it.each([success, failure, { success: false, progress: [] }])(
    "preserves the complete outcome: %j",
    (response) => {
      expect(PostInstallAppResponseSchema.parse(response)).toEqual(response);
    },
  );
  it.each([
    { ...success, pluginName: undefined },
    { ...success, leak: true },
    { ...failure, leak: true },
    { ...success, success: "yes" },
  ])("rejects %j", (input) => {
    expect(() => PostInstallAppResponseSchema.parse(input)).toThrow();
  });
  it("rejects extra progress fields", () => {
    expect(() =>
      InstallProgressEventSchema.parse({
        phase: "x",
        message: "y",
        retries: 0,
      }),
    ).toThrow();
  });
});
