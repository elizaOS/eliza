/** Regression coverage for the Cloud live progress receipt. */

import { describe, expect, it, vi } from "vitest";

import {
  CLOUD_LIVE_NAVIGATION_TIMEOUT_MS,
  CLOUD_LIVE_TRAJECTORY_DIAGNOSTIC_SCHEMA,
  CLOUD_LIVE_TRAJECTORY_PHASES,
  CLOUD_LIVE_TRAJECTORY_TIMEOUT_MS,
  createCloudLiveTrajectoryDiagnostic,
  rethrowCloudLiveFailureAfterDiagnostic,
  writeCloudLiveTrajectoryDiagnostic,
} from "./cloud-live-trajectory-diagnostic";

const ZERO_DEDICATED_CONTROL_PLANE_COUNTERS = {
  dedicatedQuoteGetRequestCount: 0,
  successfulDedicatedQuoteGetResponseCount: 0,
  clientErrorDedicatedQuoteGetResponseCount: 0,
  serverErrorDedicatedQuoteGetResponseCount: 0,
  otherDedicatedQuoteGetResponseCount: 0,
  failedDedicatedQuoteGetRequestCount: 0,
  pendingDedicatedQuoteGetRequestCount: 0,
  completedDedicatedQuoteResponseBodyCount: 0,
  parsedDedicatedQuoteResponseBodyCount: 0,
  decodedDedicatedQuoteResponseCount: 0,
  uninspectableDedicatedQuoteResponseBodyCount: 0,
  dedicatedActivationPostRequestCount: 0,
  successfulDedicatedActivationPostResponseCount: 0,
  clientErrorDedicatedActivationPostResponseCount: 0,
  serverErrorDedicatedActivationPostResponseCount: 0,
  otherDedicatedActivationPostResponseCount: 0,
  failedDedicatedActivationPostRequestCount: 0,
  pendingDedicatedActivationPostRequestCount: 0,
  completedDedicatedActivationResponseBodyCount: 0,
  parsedDedicatedActivationResponseBodyCount: 0,
  decodedDedicatedActivationReceiptCount: 0,
  uninspectableDedicatedActivationResponseBodyCount: 0,
  dedicatedActivationResponseStatus: null,
  dedicatedActivationResponseCode: null,
  dedicatedCutoverPostRequestCount: 0,
  successfulDedicatedCutoverPostResponseCount: 0,
  clientErrorDedicatedCutoverPostResponseCount: 0,
  serverErrorDedicatedCutoverPostResponseCount: 0,
  otherDedicatedCutoverPostResponseCount: 0,
  failedDedicatedCutoverPostRequestCount: 0,
  pendingDedicatedCutoverPostRequestCount: 0,
  completedDedicatedCutoverResponseBodyCount: 0,
  parsedDedicatedCutoverResponseBodyCount: 0,
  decodedDedicatedCutoverPendingResponseCount: 0,
  decodedDedicatedCutoverFinalResponseCount: 0,
  uninspectableDedicatedCutoverResponseBodyCount: 0,
  dedicatedAdoptionQuoteGetRequestCount: 0,
  successfulDedicatedAdoptionQuoteGetResponseCount: 0,
  clientErrorDedicatedAdoptionQuoteGetResponseCount: 0,
  serverErrorDedicatedAdoptionQuoteGetResponseCount: 0,
  otherDedicatedAdoptionQuoteGetResponseCount: 0,
  failedDedicatedAdoptionQuoteGetRequestCount: 0,
  pendingDedicatedAdoptionQuoteGetRequestCount: 0,
  completedDedicatedAdoptionQuoteResponseBodyCount: 0,
  parsedDedicatedAdoptionQuoteResponseBodyCount: 0,
  decodedAdoptableDedicatedAdoptionQuoteCount: 0,
  decodedUnavailableDedicatedAdoptionQuoteCount: 0,
  uninspectableDedicatedAdoptionQuoteResponseBodyCount: 0,
  dedicatedAdoptionConfirmationPostRequestCount: 0,
} as const;

const ZERO_PERSONAL_BODY_AND_RECOVERY_COUNTERS = {
  runtimeCloudRecoveryVisibleCount: 0,
  personalIdentityRetryVisibleCount: 0,
  approvalGrantedCount: 0,
  confirmationOfferCount: 0,
  confirmationClickCount: 0,
  cancellationCount: 0,
  completedPersonalIdentityResponseBodyCount: 0,
  parsedPersonalIdentityResponseBodyCount: 0,
  decodedSharedPersonalIdentityResponseCount: 0,
  decodedDedicatedPersonalIdentityResponseCount: 0,
  uninspectablePersonalIdentityResponseBodyCount: 0,
} as const;

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
      "dedicated-confirmation-required",
      456,
      {
        runtimeCloudActionAttemptCount: 1,
        runtimeCloudActionSuccessCount: 0,
        runtimeCloudActionTimeoutCount: 1,
        ...ZERO_PERSONAL_BODY_AND_RECOVERY_COUNTERS,
        personalIdentityGetRequestCount: 0,
        successfulPersonalIdentityGetResponseCount: 0,
        clientErrorPersonalIdentityGetResponseCount: 0,
        serverErrorPersonalIdentityGetResponseCount: 0,
        otherPersonalIdentityGetResponseCount: 0,
        failedPersonalIdentityGetRequestCount: 0,
        pendingPersonalIdentityGetRequestCount: 0,
        ...ZERO_DEDICATED_CONTROL_PLANE_COUNTERS,
        token: "private-token",
        selector: "private-selector",
      } as Parameters<typeof createCloudLiveTrajectoryDiagnostic>[2],
    );

    expect(diagnostic).toEqual({
      schema: CLOUD_LIVE_TRAJECTORY_DIAGNOSTIC_SCHEMA,
      phase: "dedicated-confirmation-required",
      elapsedMs: 456,
      preIdentity: {
        runtimeCloudActionAttemptCount: 1,
        runtimeCloudActionSuccessCount: 0,
        runtimeCloudActionTimeoutCount: 1,
        ...ZERO_PERSONAL_BODY_AND_RECOVERY_COUNTERS,
        personalIdentityGetRequestCount: 0,
        successfulPersonalIdentityGetResponseCount: 0,
        clientErrorPersonalIdentityGetResponseCount: 0,
        serverErrorPersonalIdentityGetResponseCount: 0,
        otherPersonalIdentityGetResponseCount: 0,
        failedPersonalIdentityGetRequestCount: 0,
        pendingPersonalIdentityGetRequestCount: 0,
        ...ZERO_DEDICATED_CONTROL_PLANE_COUNTERS,
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
      ...ZERO_PERSONAL_BODY_AND_RECOVERY_COUNTERS,
      personalIdentityGetRequestCount: 0,
      successfulPersonalIdentityGetResponseCount: 0,
      clientErrorPersonalIdentityGetResponseCount: 0,
      serverErrorPersonalIdentityGetResponseCount: 0,
      otherPersonalIdentityGetResponseCount: 0,
      failedPersonalIdentityGetRequestCount: 0,
      pendingPersonalIdentityGetRequestCount: -1,
      ...ZERO_DEDICATED_CONTROL_PLANE_COUNTERS,
    };

    expect(() =>
      createCloudLiveTrajectoryDiagnostic(
        "pre-identity-runtime-choice",
        456,
        counters,
      ),
    ).toThrow("pre-identity counters must be non-negative integers");
  });

  it("retains only a bounded Dedicated activation status and machine code", () => {
    const counters = {
      runtimeCloudActionAttemptCount: 1,
      runtimeCloudActionSuccessCount: 0,
      runtimeCloudActionTimeoutCount: 0,
      ...ZERO_PERSONAL_BODY_AND_RECOVERY_COUNTERS,
      personalIdentityGetRequestCount: 1,
      successfulPersonalIdentityGetResponseCount: 1,
      clientErrorPersonalIdentityGetResponseCount: 0,
      serverErrorPersonalIdentityGetResponseCount: 0,
      otherPersonalIdentityGetResponseCount: 0,
      failedPersonalIdentityGetRequestCount: 0,
      pendingPersonalIdentityGetRequestCount: 0,
      ...ZERO_DEDICATED_CONTROL_PLANE_COUNTERS,
      dedicatedActivationResponseStatus: 409,
      dedicatedActivationResponseCode: "dedicated_quote_changed",
    };

    const diagnostic = createCloudLiveTrajectoryDiagnostic(
      "personal-identity",
      456,
      counters,
    );
    expect(diagnostic.preIdentity).toMatchObject({
      dedicatedActivationResponseStatus: 409,
      dedicatedActivationResponseCode: "dedicated_quote_changed",
    });
    expect(() =>
      createCloudLiveTrajectoryDiagnostic("personal-identity", 456, {
        ...counters,
        dedicatedActivationResponseCode: "private message: user@example.com",
      }),
    ).toThrow("bounded machine code");
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

  it("preserves the original trajectory failure when its diagnostic writes", async () => {
    const originalCause = new Error("Personal identity did not resolve");
    const writeDiagnostic = vi.fn(async () => undefined);

    await expect(
      rethrowCloudLiveFailureAfterDiagnostic(originalCause, writeDiagnostic),
    ).rejects.toBe(originalCause);
    expect(writeDiagnostic).toHaveBeenCalledOnce();
  });

  it("preserves the original trajectory failure when its diagnostic rejects", async () => {
    const originalCause = new Error("Personal identity did not resolve");
    const writeDiagnostic = vi.fn(async () => {
      throw new Error("diagnostic storage unavailable");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      rethrowCloudLiveFailureAfterDiagnostic(originalCause, writeDiagnostic),
    ).rejects.toBe(originalCause);
    expect(writeDiagnostic).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "[cloud-live] trajectory diagnostic write unavailable",
    );
  });
});
