import { describe, expect, it } from "vitest";
import {
  parseAccountDeletionEnvelope,
  parseAccountDeletionRequest,
} from "./account-deletion-contract";

function lifecycleRequest(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "receipt_opaque_1",
    phase: "recovery_window",
    requestedAt: "2026-08-22T00:00:00.000Z",
    recoveryEndsAt: "2026-08-29T00:00:00.000Z",
    scheduledDeletionAt: "2026-08-29T00:00:00.000Z",
    completedAt: null,
    identityDeactivated: true,
    canCancel: true,
    canExport: true,
    nextPollAfterMs: 5_000,
    progress: null,
    export: {
      status: "not_requested",
      downloadUrl: null,
      expiresAt: null,
    },
    actionRequiredCode: null,
    ...overrides,
  };
}

describe("Android account-deletion lifecycle contract", () => {
  it("parses the dedicated deletion owner's lifecycle DTO", () => {
    expect(
      parseAccountDeletionEnvelope({ request: lifecycleRequest() }),
    ).toMatchObject({
      requestId: "receipt_opaque_1",
      phase: "recovery_window",
      canCancel: true,
      canExport: true,
    });
  });

  it("fails closed on the legacy status-only backend DTO", () => {
    expect(() =>
      parseAccountDeletionRequest({
        requestId: "database-id",
        status: "pending",
        requestedAt: "2026-08-22T00:00:00.000Z",
        scheduledDeletionAt: "2026-09-21T00:00:00.000Z",
        identityDeactivated: false,
        completedAt: null,
      }),
    ).toThrow("malformed");
  });

  it("bounds server polling hints and rejects inconsistent progress", () => {
    expect(
      parseAccountDeletionRequest(lifecycleRequest({ nextPollAfterMs: 1 }))
        .nextPollAfterMs,
    ).toBe(1_000);
    expect(
      parseAccountDeletionRequest(
        lifecycleRequest({ nextPollAfterMs: 120_000 }),
      ).nextPollAfterMs,
    ).toBe(60_000);
    expect(() =>
      parseAccountDeletionRequest(
        lifecycleRequest({
          progress: {
            completedSteps: 2,
            totalSteps: 1,
            currentStep: "provider purge",
          },
        }),
      ),
    ).toThrow("inconsistent progress");
  });
});
