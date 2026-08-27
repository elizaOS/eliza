/** Regression coverage for the Cloud live progress receipt. */

import { describe, expect, it, vi } from "vitest";

import {
  CLOUD_LIVE_NAVIGATION_TIMEOUT_MS,
  CLOUD_LIVE_TRAJECTORY_DIAGNOSTIC_SCHEMA,
  CLOUD_LIVE_TRAJECTORY_PHASES,
  CLOUD_LIVE_TRAJECTORY_TIMEOUT_MS,
  createCloudLiveTrajectoryDiagnostic,
  writeCloudLiveTrajectoryDiagnostic,
} from "./cloud-live-trajectory-diagnostic";

describe("Cloud live trajectory diagnostic", () => {
  it("allows the complete bounded trajectory within the 45-minute job", () => {
    expect(CLOUD_LIVE_TRAJECTORY_TIMEOUT_MS).toBe(35 * 60 * 1_000);
    expect(CLOUD_LIVE_TRAJECTORY_TIMEOUT_MS).toBeLessThan(45 * 60 * 1_000);
    expect(CLOUD_LIVE_NAVIGATION_TIMEOUT_MS).toBe(2 * 60 * 1_000);
    expect(CLOUD_LIVE_NAVIGATION_TIMEOUT_MS).toBeLessThan(
      CLOUD_LIVE_TRAJECTORY_TIMEOUT_MS,
    );
  });

  it.each(CLOUD_LIVE_TRAJECTORY_PHASES)(
    "creates the closed %s phase receipt",
    (phase) => {
      expect(createCloudLiveTrajectoryDiagnostic(phase, 123)).toEqual({
        schema: CLOUD_LIVE_TRAJECTORY_DIAGNOSTIC_SCHEMA,
        phase,
        elapsedMs: 123,
      });
    },
  );

  it("rejects invalid timing values", () => {
    expect(() => createCloudLiveTrajectoryDiagnostic("live-chat", -1)).toThrow(
      "trajectory elapsed time must be non-negative",
    );
    expect(() =>
      createCloudLiveTrajectoryDiagnostic("live-chat", Number.NaN),
    ).toThrow("trajectory elapsed time must be non-negative");
  });

  it("records only closed pre-identity action and request counters", () => {
    const diagnostic = createCloudLiveTrajectoryDiagnostic(
      "pre-identity-runtime-choice",
      456,
      {
        runtimeCloudActionAttemptCount: 1,
        runtimeCloudActionSuccessCount: 0,
        runtimeCloudActionTimeoutCount: 1,
        personalIdentityGetRequestCount: 0,
        successfulPersonalIdentityGetResponseCount: 0,
        clientErrorPersonalIdentityGetResponseCount: 0,
        serverErrorPersonalIdentityGetResponseCount: 0,
        otherPersonalIdentityGetResponseCount: 0,
        failedPersonalIdentityGetRequestCount: 0,
        pendingPersonalIdentityGetRequestCount: 0,
        token: "private-token",
        selector: "private-selector",
      } as Parameters<typeof createCloudLiveTrajectoryDiagnostic>[2],
    );

    expect(diagnostic).toEqual({
      schema: CLOUD_LIVE_TRAJECTORY_DIAGNOSTIC_SCHEMA,
      phase: "pre-identity-runtime-choice",
      elapsedMs: 456,
      preIdentity: {
        runtimeCloudActionAttemptCount: 1,
        runtimeCloudActionSuccessCount: 0,
        runtimeCloudActionTimeoutCount: 1,
        personalIdentityGetRequestCount: 0,
        successfulPersonalIdentityGetResponseCount: 0,
        clientErrorPersonalIdentityGetResponseCount: 0,
        serverErrorPersonalIdentityGetResponseCount: 0,
        otherPersonalIdentityGetResponseCount: 0,
        failedPersonalIdentityGetRequestCount: 0,
        pendingPersonalIdentityGetRequestCount: 0,
      },
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(
      /selector|locator|https?:|token|transcript/i,
    );

    expect(
      createCloudLiveTrajectoryDiagnostic(
        "personal-identity",
        789,
        diagnostic.preIdentity,
      ),
    ).toEqual({
      schema: CLOUD_LIVE_TRAJECTORY_DIAGNOSTIC_SCHEMA,
      phase: "personal-identity",
      elapsedMs: 789,
      preIdentity: diagnostic.preIdentity,
    });
  });

  it("rejects invalid pre-identity counters", () => {
    const counters = {
      runtimeCloudActionAttemptCount: 1,
      runtimeCloudActionSuccessCount: 0,
      runtimeCloudActionTimeoutCount: 0,
      personalIdentityGetRequestCount: 0,
      successfulPersonalIdentityGetResponseCount: 0,
      clientErrorPersonalIdentityGetResponseCount: 0,
      serverErrorPersonalIdentityGetResponseCount: 0,
      otherPersonalIdentityGetResponseCount: 0,
      failedPersonalIdentityGetRequestCount: 0,
      pendingPersonalIdentityGetRequestCount: -1,
    };

    expect(() =>
      createCloudLiveTrajectoryDiagnostic(
        "pre-identity-runtime-choice",
        456,
        counters,
      ),
    ).toThrow("pre-identity counters must be non-negative integers");
  });

  it("overwrites one private receipt with restrictive permissions", async () => {
    const mkdirFn = vi.fn(async () => undefined);
    let written = "";
    const writeFileFn = vi.fn(async (_path, data) => {
      written = String(data);
    });

    await writeCloudLiveTrajectoryDiagnostic({
      diagnosticPath: "/tmp/eliza-live/progress.json",
      phase: "post-reload-navigation",
      elapsedMs: 456,
      mkdirFn,
      writeFileFn,
      // Exercise the JavaScript boundary: unrecognized caller data must not
      // enter the closed receipt even if a dynamically typed caller supplies it.
      token: "private-token",
      transcript: "private-transcript",
    } as Parameters<typeof writeCloudLiveTrajectoryDiagnostic>[0]);

    expect(mkdirFn).toHaveBeenCalledWith("/tmp/eliza-live", {
      recursive: true,
      mode: 0o700,
    });
    expect(writeFileFn).toHaveBeenCalledWith(
      "/tmp/eliza-live/progress.json",
      expect.any(String),
      { encoding: "utf8", flag: "w", mode: 0o600 },
    );
    expect(JSON.parse(written)).toEqual({
      schema: CLOUD_LIVE_TRAJECTORY_DIAGNOSTIC_SCHEMA,
      phase: "post-reload-navigation",
      elapsedMs: 456,
    });
    expect(written).not.toContain("private-token");
    expect(written).not.toContain("private-transcript");
  });
});
