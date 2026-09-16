import { describe, expect, it } from "vitest";
import {
  parseAccountDeletionAccepted,
  parseAccountDeletionAvailability,
  parseAccountDeletionEnvelope,
  parseAccountDeletionRequest,
} from "./account-deletion-contract";

const STATUS_CAPABILITY = "s".repeat(43);
const RECOVERY_CAPABILITY = "r".repeat(43);

function lifecycleRequest(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "receipt_opaque_1",
    status: "recovery",
    requestedAt: "2026-08-22T00:00:00.000Z",
    recoveryExpiresAt: "2026-09-21T00:00:00.000Z",
    scheduledDeletionAt: "2026-09-21T00:00:00.000Z",
    irreversibleAt: null,
    completedAt: null,
    identityDeactivated: true,
    accessState: "fenced",
    canCancel: true,
    nextAction: "download_export_or_cancel",
    export: {
      status: "ready",
      readyAt: "2026-08-22T00:01:00.000Z",
      expiresAt: "2026-09-21T00:00:00.000Z",
      contentDigest: "a".repeat(64),
    },
    ...overrides,
  };
}

describe("Android account-deletion lifecycle contract", () => {
  it("normalizes current fail-closed and reserved lifecycle availability", () => {
    expect(parseAccountDeletionAvailability({ request: null })).toEqual({
      state: "available",
      request: null,
    });
    expect(
      parseAccountDeletionAvailability({
        state: "lifecycle_unavailable",
        request: null,
        code: "LIFECYCLE_RESERVATION_REQUIRED",
        message: "Lifecycle reservation required",
      }),
    ).toEqual({
      state: "lifecycle_unavailable",
      request: null,
      code: "LIFECYCLE_RESERVATION_REQUIRED",
      message: "Lifecycle reservation required",
    });
    expect(
      parseAccountDeletionAvailability({
        state: "transfer_required",
        request: null,
        code: "TRANSFER_REQUIRED",
        message: "Transfer shared resources",
      }),
    ).toEqual({
      state: "transfer_required",
      request: null,
      code: "TRANSFER_REQUIRED",
      message: "Transfer shared resources",
    });
  });

  it("parses the exact identifier-minimal DTO from owner checkpoint e6f002fd2e", () => {
    expect(
      parseAccountDeletionEnvelope({ request: lifecycleRequest() }),
    ).toMatchObject({
      status: "recovery",
      nextAction: "download_export_or_cancel",
      export: { status: "ready", contentDigest: "a".repeat(64) },
    });
  });

  it("parses two independent one-time capabilities only on acceptance", () => {
    expect(
      parseAccountDeletionAccepted({
        request: lifecycleRequest({
          status: "reserved",
          nextAction: "wait_for_export",
        }),
        statusCredential: STATUS_CAPABILITY,
        recoveryCredential: RECOVERY_CAPABILITY,
      }),
    ).toMatchObject({
      request: { status: "reserved" },
      statusCredential: STATUS_CAPABILITY,
      recoveryCredential: RECOVERY_CAPABILITY,
    });
    expect(() =>
      parseAccountDeletionAccepted({
        request: lifecycleRequest(),
        statusCredential: STATUS_CAPABILITY,
        recoveryCredential: STATUS_CAPABILITY,
      }),
    ).toThrow(/independent/);
  });

  it("distinguishes fenced cancellation cleanup from restored terminal cancellation", () => {
    expect(
      parseAccountDeletionRequest(
        lifecycleRequest({
          status: "canceling",
          canCancel: false,
          nextAction: "wait_for_reconciliation",
        }),
      ),
    ).toMatchObject({
      status: "canceling",
      accessState: "fenced",
      nextAction: "wait_for_reconciliation",
    });
    expect(
      parseAccountDeletionRequest(
        lifecycleRequest({
          status: "canceled",
          identityDeactivated: false,
          accessState: "active",
          canCancel: false,
          nextAction: "none",
        }),
      ),
    ).toMatchObject({
      status: "canceled",
      accessState: "active",
      nextAction: "none",
    });
  });

  it("fails closed on inconsistent access, cancellation, and next-action state", () => {
    expect(() =>
      parseAccountDeletionRequest(
        lifecycleRequest({
          status: "canceled",
          canCancel: false,
          nextAction: "none",
        }),
      ),
    ).toThrow(/inconsistent lifecycle state/);
    expect(() =>
      parseAccountDeletionRequest(
        lifecycleRequest({ status: "canceling", canCancel: false }),
      ),
    ).toThrow(/inconsistent lifecycle state/);
  });

  it("accepts the server-owned provider-attention state without internal errors", () => {
    expect(
      parseAccountDeletionRequest(
        lifecycleRequest({
          status: "action_required",
          canCancel: false,
          nextAction: "contact_support",
        }),
      ),
    ).toMatchObject({
      status: "action_required",
      accessState: "fenced",
      nextAction: "contact_support",
    });
  });

  it("fails closed on the superseded draft and legacy response shapes", () => {
    expect(() =>
      parseAccountDeletionRequest({
        ...lifecycleRequest(),
        status: undefined,
        phase: "recovery_window",
      }),
    ).toThrow(/malformed/);
    expect(() =>
      parseAccountDeletionRequest({
        status: "pending",
        requestedAt: "2026-08-22T00:00:00.000Z",
      }),
    ).toThrow(/malformed/);
  });

  it("rejects malformed export integrity evidence", () => {
    expect(() =>
      parseAccountDeletionRequest({
        ...lifecycleRequest(),
        export: {
          status: "ready",
          readyAt: null,
          expiresAt: "2026-09-21T00:00:00.000Z",
          contentDigest: "not-a-sha256",
        },
      }),
    ).toThrow(/contentDigest/);
  });
});
