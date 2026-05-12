import { describe, expect, it } from "vitest";
import {
  AppLaunchDiagnosticSchema,
  AppLaunchResultSchema,
  AppRunAwaySummarySchema,
  AppRunEventSchema,
  AppRunHealthDetailsSchema,
  AppRunHealthFacetSchema,
  AppRunHealthSchema,
  AppRunSummarySchema,
  AppSessionActivityItemSchema,
  AppSessionJsonValueSchema,
  AppSessionRecommendationSchema,
  AppSessionStateSchema,
  AppStopResultSchema,
  AppVerifyResultSchema,
  AppViewerAuthMessageSchema,
  AppViewerConfigSchema,
  PostRelaunchAppResponseSchema,
} from "./apps.js";

const HEALTHY_FACET = { state: "healthy" as const, message: null };
const HEALTH_DETAILS = {
  checkedAt: "2026-05-11T01:00:00Z",
  auth: HEALTHY_FACET,
  runtime: HEALTHY_FACET,
  viewer: HEALTHY_FACET,
  chat: HEALTHY_FACET,
  control: HEALTHY_FACET,
  message: null,
};

const RUN_SUMMARY = {
  runId: "run-1",
  appName: "companion",
  displayName: "Companion",
  pluginName: "@elizaos/app-companion",
  launchType: "viewer",
  launchUrl: "http://x",
  viewer: null,
  session: null,
  characterId: null,
  agentId: null,
  status: "running",
  summary: null,
  startedAt: "2026-05-11T00:00:00Z",
  updatedAt: "2026-05-11T01:00:00Z",
  lastHeartbeatAt: null,
  supportsBackground: false,
  supportsViewerDetach: false,
  chatAvailability: "available" as const,
  controlAvailability: "available" as const,
  viewerAttachment: "attached" as const,
  recentEvents: [],
  awaySummary: null,
  health: { state: "healthy" as const, message: null },
  healthDetails: HEALTH_DETAILS,
};

describe("AppSessionJsonValueSchema", () => {
  it("accepts primitives", () => {
    expect(AppSessionJsonValueSchema.parse("hello")).toBe("hello");
    expect(AppSessionJsonValueSchema.parse(42)).toBe(42);
    expect(AppSessionJsonValueSchema.parse(true)).toBe(true);
    expect(AppSessionJsonValueSchema.parse(null)).toBe(null);
  });

  it("accepts nested arrays + objects", () => {
    const value = { a: [1, "two", null, { b: false }] };
    expect(AppSessionJsonValueSchema.parse(value)).toEqual(value);
  });

  it("rejects undefined", () => {
    expect(() => AppSessionJsonValueSchema.parse(undefined)).toThrow();
  });

  it("rejects functions", () => {
    expect(() => AppSessionJsonValueSchema.parse(() => 0)).toThrow();
  });
});

describe("AppViewerAuthMessageSchema", () => {
  it("accepts the minimal shape", () => {
    expect(AppViewerAuthMessageSchema.parse({ type: "auth" })).toEqual({
      type: "auth",
    });
  });

  it("accepts all optional fields", () => {
    const v = {
      type: "auth",
      authToken: "tok",
      characterId: "c",
      sessionToken: "s",
      agentId: "a",
      followEntity: "e",
    };
    expect(AppViewerAuthMessageSchema.parse(v)).toEqual(v);
  });

  it("rejects missing type", () => {
    expect(() => AppViewerAuthMessageSchema.parse({})).toThrow();
  });
});

describe("AppViewerConfigSchema", () => {
  it("accepts a minimal viewer config", () => {
    expect(AppViewerConfigSchema.parse({ url: "http://x" })).toEqual({
      url: "http://x",
    });
  });

  it("accepts embedParams + sandbox + auth", () => {
    const v = {
      url: "http://x",
      embedParams: { id: "1" },
      postMessageAuth: true,
      sandbox: "allow-scripts",
      authMessage: { type: "auth" },
    };
    expect(AppViewerConfigSchema.parse(v)).toEqual(v);
  });
});

describe("AppSessionRecommendationSchema", () => {
  it("accepts id+label only", () => {
    const v = { id: "r1", label: "Try this" };
    expect(AppSessionRecommendationSchema.parse(v)).toEqual(v);
  });

  it("accepts nullable reason / priority / command", () => {
    const v = {
      id: "r1",
      label: "Try this",
      reason: null,
      priority: null,
      command: null,
    };
    expect(AppSessionRecommendationSchema.parse(v)).toEqual(v);
  });
});

describe("AppSessionActivityItemSchema", () => {
  it("accepts a minimal activity item", () => {
    const v = { id: "a1", type: "message", message: "hi" };
    expect(AppSessionActivityItemSchema.parse(v)).toEqual(v);
  });

  it("accepts a severity", () => {
    const v = {
      id: "a1",
      type: "log",
      message: "warn",
      severity: "warning" as const,
    };
    expect(AppSessionActivityItemSchema.parse(v)).toEqual(v);
  });

  it("rejects an unknown severity", () => {
    expect(() =>
      AppSessionActivityItemSchema.parse({
        id: "a1",
        type: "log",
        message: "x",
        severity: "fatal",
      }),
    ).toThrow();
  });
});

describe("AppSessionStateSchema", () => {
  it("accepts a minimal session", () => {
    const v = {
      sessionId: "s1",
      appName: "companion",
      mode: "viewer" as const,
      status: "active",
    };
    expect(AppSessionStateSchema.parse(v)).toEqual(v);
  });

  it("accepts a populated session", () => {
    const v = {
      sessionId: "s1",
      appName: "companion",
      mode: "spectate-and-steer" as const,
      status: "active",
      controls: ["pause", "resume"] as const,
      summary: null,
      goalLabel: "Wash dishes",
      suggestedPrompts: ["pause", "resume"],
      recommendations: [{ id: "r1", label: "Pause" }],
      activity: [{ id: "a1", type: "log", message: "started" }],
      telemetry: { foo: { bar: [1, 2, 3] } },
    };
    expect(AppSessionStateSchema.parse(v)).toEqual(v);
  });

  it("rejects unknown mode", () => {
    expect(() =>
      AppSessionStateSchema.parse({
        sessionId: "s",
        appName: "c",
        mode: "rogue",
        status: "active",
      }),
    ).toThrow();
  });
});

describe("AppRunHealthSchema + AppRunHealthFacetSchema + AppRunHealthDetailsSchema", () => {
  it("accepts a healthy summary", () => {
    expect(
      AppRunHealthSchema.parse({ state: "healthy", message: null }),
    ).toEqual({ state: "healthy", message: null });
  });

  it("facet allows the unknown state", () => {
    expect(
      AppRunHealthFacetSchema.parse({ state: "unknown", message: null }),
    ).toEqual({ state: "unknown", message: null });
  });

  it("details accepts the standard shape", () => {
    expect(AppRunHealthDetailsSchema.parse(HEALTH_DETAILS)).toEqual(
      HEALTH_DETAILS,
    );
  });

  it("rejects unknown enum values on the top-level state", () => {
    expect(() =>
      AppRunHealthSchema.parse({ state: "weird", message: null }),
    ).toThrow();
  });
});

describe("AppRunEventSchema", () => {
  it("accepts a minimal event", () => {
    const v = {
      eventId: "e1",
      kind: "launch" as const,
      severity: "info" as const,
      message: "Launched",
      createdAt: "2026-05-11T01:00:00Z",
    };
    expect(AppRunEventSchema.parse(v)).toEqual(v);
  });

  it("accepts nullable status + recursive details", () => {
    const v = {
      eventId: "e1",
      kind: "status" as const,
      severity: "warning" as const,
      message: "degraded",
      createdAt: "2026-05-11T01:00:00Z",
      status: null,
      details: { score: 0.8, nested: { ok: true } },
    };
    expect(AppRunEventSchema.parse(v)).toEqual(v);
  });
});

describe("AppRunAwaySummarySchema", () => {
  it("accepts the standard shape", () => {
    const v = {
      generatedAt: "2026-05-11T01:00:00Z",
      message: "Caught up",
      eventCount: 3,
      since: "2026-05-11T00:00:00Z",
      until: null,
    };
    expect(AppRunAwaySummarySchema.parse(v)).toEqual(v);
  });
});

describe("AppRunSummarySchema", () => {
  it("accepts the canonical run summary", () => {
    expect(AppRunSummarySchema.parse(RUN_SUMMARY)).toEqual(RUN_SUMMARY);
  });

  it("rejects missing healthDetails", () => {
    const broken = { ...RUN_SUMMARY } as Record<string, unknown>;
    delete broken.healthDetails;
    expect(() => AppRunSummarySchema.parse(broken)).toThrow();
  });
});

describe("AppLaunchDiagnosticSchema", () => {
  it("accepts a diagnostic", () => {
    const v = { code: "x", severity: "info" as const, message: "noted" };
    expect(AppLaunchDiagnosticSchema.parse(v)).toEqual(v);
  });
});

describe("AppLaunchResultSchema", () => {
  it("accepts a minimal launch result with no run", () => {
    const v = {
      pluginInstalled: true,
      needsRestart: false,
      displayName: "Companion",
      launchType: "viewer",
      launchUrl: null,
      viewer: null,
      session: null,
      run: null,
    };
    expect(AppLaunchResultSchema.parse(v)).toEqual(v);
  });

  it("accepts a run + diagnostics", () => {
    const v = {
      pluginInstalled: true,
      needsRestart: false,
      displayName: "Companion",
      launchType: "viewer",
      launchUrl: "http://x",
      viewer: { url: "http://x" },
      session: null,
      run: RUN_SUMMARY,
      diagnostics: [{ code: "x", severity: "info" as const, message: "ok" }],
    };
    expect(AppLaunchResultSchema.parse(v)).toEqual(v);
  });
});

describe("AppStopResultSchema", () => {
  it("accepts the canonical stop result", () => {
    const v = {
      success: true,
      appName: "companion",
      runId: "run-1",
      stoppedAt: "2026-05-11T01:00:00Z",
      pluginUninstalled: false,
      needsRestart: false,
      stopScope: "viewer-session" as const,
      message: "Stopped",
    };
    expect(AppStopResultSchema.parse(v)).toEqual(v);
  });

  it("rejects an unknown stopScope", () => {
    expect(() =>
      AppStopResultSchema.parse({
        success: false,
        appName: "x",
        runId: null,
        stoppedAt: "2026-05-11T01:00:00Z",
        pluginUninstalled: false,
        needsRestart: false,
        stopScope: "rogue",
        message: "?",
      }),
    ).toThrow();
  });
});

describe("AppVerifyResultSchema", () => {
  it("accepts a verdict-only result", () => {
    expect(AppVerifyResultSchema.parse({ verdict: "pass" })).toEqual({
      verdict: "pass",
    });
  });

  it("accepts a retryablePromptForChild", () => {
    const v = { verdict: "fail", retryablePromptForChild: "try again" };
    expect(AppVerifyResultSchema.parse(v)).toEqual(v);
  });
});

describe("PostRelaunchAppResponseSchema", () => {
  const launch = {
    pluginInstalled: true,
    needsRestart: false,
    displayName: "Companion",
    launchType: "viewer",
    launchUrl: null,
    viewer: null,
    session: null,
    run: null,
  };

  it("accepts launch + null verify", () => {
    expect(
      PostRelaunchAppResponseSchema.parse({ launch, verify: null }),
    ).toEqual({ launch, verify: null });
  });

  it("accepts launch + verify result", () => {
    expect(
      PostRelaunchAppResponseSchema.parse({
        launch,
        verify: { verdict: "pass" },
      }),
    ).toEqual({ launch, verify: { verdict: "pass" } });
  });
});
