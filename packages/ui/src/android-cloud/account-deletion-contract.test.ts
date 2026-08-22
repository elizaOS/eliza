import { describe, expect, it } from "vitest";
import {
  parseAccountDeletionAccepted,
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
  it("parses the exact identifier-minimal DTO from owner candidate 398b2e79", () => {
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
        request: lifecycleRequest({ status: "reserved" }),
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
