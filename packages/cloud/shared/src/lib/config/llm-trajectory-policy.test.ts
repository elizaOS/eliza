// Verifies the deployment model-call recording policy and retention parsing.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  describeModelCallRecording,
  resolveTrajectoryCapturePolicy,
  resolveTrajectoryRetentionDays,
  TrajectoryPolicyConfigError,
} from "./llm-trajectory-policy";

describe("resolveTrajectoryCapturePolicy", () => {
  test("an explicit on/off wins over the deployment default", () => {
    expect(
      resolveTrajectoryCapturePolicy({ ENVIRONMENT: "production", LLM_TRAJECTORY_CAPTURE: "on" }),
    ).toEqual({ enabled: true, source: "explicit" });
    expect(
      resolveTrajectoryCapturePolicy({ ENVIRONMENT: "staging", LLM_TRAJECTORY_CAPTURE: "off" }),
    ).toEqual({ enabled: false, source: "explicit" });
  });

  test("rejects any other value instead of guessing", () => {
    for (const value of ["true", "ON", "1", "yes"]) {
      expect(() => resolveTrajectoryCapturePolicy({ LLM_TRAJECTORY_CAPTURE: value })).toThrow(
        TrajectoryPolicyConfigError,
      );
    }
  });

  test("production defaults off; staging and local default on", () => {
    expect(resolveTrajectoryCapturePolicy({ ENVIRONMENT: "production" })).toEqual({
      enabled: false,
      source: "deployment-default",
    });
    expect(resolveTrajectoryCapturePolicy({ NODE_ENV: "production" })).toEqual({
      enabled: false,
      source: "deployment-default",
    });
    expect(
      resolveTrajectoryCapturePolicy({ ENVIRONMENT: "staging", NODE_ENV: "production" }),
    ).toEqual({ enabled: true, source: "deployment-default" });
    expect(resolveTrajectoryCapturePolicy({ NODE_ENV: "development" })).toEqual({
      enabled: true,
      source: "deployment-default",
    });
  });
});

describe("resolveTrajectoryRetentionDays", () => {
  test("defaults to 90 days and accepts a positive whole number", () => {
    expect(resolveTrajectoryRetentionDays({})).toBe(90);
    expect(resolveTrajectoryRetentionDays({ LLM_TRAJECTORY_RETENTION_DAYS: "30" })).toBe(30);
  });

  test("rejects non-positive and malformed values", () => {
    for (const value of ["0", "-5", "1.5", "abc", "007", " 30"]) {
      expect(() =>
        resolveTrajectoryRetentionDays({ LLM_TRAJECTORY_RETENTION_DAYS: value }),
      ).toThrow(TrajectoryPolicyConfigError);
    }
  });

  test("the disclosure combines policy and retention", () => {
    expect(
      describeModelCallRecording({
        ENVIRONMENT: "production",
        LLM_TRAJECTORY_CAPTURE: "on",
        LLM_TRAJECTORY_RETENTION_DAYS: "14",
      }),
    ).toEqual({ enabled: true, source: "explicit", retentionDays: 14 });
  });
});

describe("ai-billing capture gate", () => {
  test("uses the deployment policy and never consults user consents", () => {
    const source = readFileSync(new URL("../services/ai-billing.ts", import.meta.url), "utf8");
    expect(source).toContain("resolveTrajectoryCapturePolicy");
    expect(source).not.toContain("user-consents");
    expect(source).not.toContain("isTrajectoryCaptureAllowed");
  });
});
