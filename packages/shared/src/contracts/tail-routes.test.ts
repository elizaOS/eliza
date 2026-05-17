import { describe, expect, it } from "vitest";
import {
  PostBugReportRequestSchema,
  PutUpdateChannelRequestSchema,
} from "./tail-routes.js";

describe("PostBugReportRequestSchema", () => {
  it("accepts minimal required fields", () => {
    expect(
      PostBugReportRequestSchema.parse({
        description: "thing broke",
        stepsToReproduce: "click x",
      }),
    ).toEqual({
      description: "thing broke",
      stepsToReproduce: "click x",
    });
  });

  it("accepts a fully populated bug report", () => {
    const parsed = PostBugReportRequestSchema.parse({
      description: "x",
      stepsToReproduce: "y",
      expectedBehavior: "ok",
      actualBehavior: "fail",
      environment: "macos",
      nodeVersion: "22",
      modelProvider: "openai",
      logs: "trace",
      category: "startup-failure",
      appVersion: "1.0.0",
      releaseChannel: "stable",
      startup: {
        reason: "boot",
        phase: "init",
        message: "msg",
        detail: "d",
        status: 500,
        path: "/api/x",
      },
    });
    expect(parsed.startup?.status).toBe(500);
  });

  it("rejects whitespace-only description", () => {
    expect(() =>
      PostBugReportRequestSchema.parse({
        description: " ",
        stepsToReproduce: "y",
      }),
    ).toThrow(/description is required/);
  });

  it("rejects whitespace-only stepsToReproduce", () => {
    expect(() =>
      PostBugReportRequestSchema.parse({
        description: "x",
        stepsToReproduce: " ",
      }),
    ).toThrow(/stepsToReproduce is required/);
  });

  it("rejects unknown category", () => {
    expect(() =>
      PostBugReportRequestSchema.parse({
        description: "x",
        stepsToReproduce: "y",
        category: "feature-request",
      }),
    ).toThrow();
  });

  it("rejects extra startup field", () => {
    expect(() =>
      PostBugReportRequestSchema.parse({
        description: "x",
        stepsToReproduce: "y",
        startup: { reason: "boot", undocumented: "x" },
      }),
    ).toThrow();
  });

  it("rejects extra body fields", () => {
    expect(() =>
      PostBugReportRequestSchema.parse({
        description: "x",
        stepsToReproduce: "y",
        priority: 1,
      }),
    ).toThrow();
  });
});

describe("PutUpdateChannelRequestSchema", () => {
  it("accepts each valid channel", () => {
    for (const channel of ["stable", "beta", "nightly"] as const) {
      expect(PutUpdateChannelRequestSchema.parse({ channel })).toEqual({
        channel,
      });
    }
  });

  it("rejects unknown channel", () => {
    expect(() =>
      PutUpdateChannelRequestSchema.parse({ channel: "alpha" }),
    ).toThrow();
  });

  it("rejects missing channel", () => {
    expect(() => PutUpdateChannelRequestSchema.parse({})).toThrow();
  });

  it("rejects extra fields", () => {
    expect(() =>
      PutUpdateChannelRequestSchema.parse({
        channel: "stable",
        force: true,
      }),
    ).toThrow();
  });
});
