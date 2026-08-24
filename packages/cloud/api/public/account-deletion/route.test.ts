/** Verifies public deletion request auth and opaque post-session status access. */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const requireRecentSessionUserWithOrg = mock(async () => ({
  id: "11111111-1111-4111-8111-111111111111",
  organization_id: "22222222-2222-4222-8222-222222222222",
  steward_id: "steward-1",
}));
const checkElizaMutatingRequestOrigin = mock(() => ({ ok: true }));
const getAccountDeletionStatusByCredential = mock(async (credential: string) =>
  credential === "valid-status-capability"
    ? {
        requestId: "33333333-3333-4333-8333-333333333333",
        status: "recovery",
        canCancel: true,
      }
    : null,
);
const requestAccountDeletion = mock(async () => ({
  request: {
    requestId: "33333333-3333-4333-8333-333333333333",
    status: "reserved",
  },
  statusCredential: "status-capability",
  recoveryCredential: "recovery-capability",
}));
const recoverAccountDeletionAdmission = mock(
  async (): Promise<Record<string, unknown> | null> => null,
);
const admissionCredential = "a".repeat(43);
const cancelAccountDeletion = mock(async (credential: string) => ({
  requestId: "33333333-3333-4333-8333-333333333333",
  status: "canceled",
  credentialAccepted: credential === "recovery-capability",
}));
class AccountDeletionRecoveryError extends Error {
  constructor(
    message: string,
    readonly code: "STATUS_CREDENTIAL_INVALID" | "RECOVERY_WINDOW_EXPIRED",
  ) {
    super(message);
  }
}

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireRecentSessionUserWithOrg,
}));
mock.module("@/lib/auth/browser-origin-policy", () => ({
  checkElizaMutatingRequestOrigin,
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { CRITICAL: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) =>
    await next(),
}));
mock.module("@/lib/services/account-deletion", () => ({
  AccountDeletionConflictError: class extends Error {},
  AccountDeletionRecoveryError,
  cancelAccountDeletion,
  getAccountDeletionStatusByCredential,
  recoverAccountDeletionAdmission,
  requestAccountDeletion,
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(() => undefined) },
}));

const { default: app } = await import("./route");

beforeEach(() => {
  requireRecentSessionUserWithOrg.mockClear();
  checkElizaMutatingRequestOrigin.mockReset();
  checkElizaMutatingRequestOrigin.mockReturnValue({ ok: true });
  getAccountDeletionStatusByCredential.mockClear();
  requestAccountDeletion.mockClear();
  recoverAccountDeletionAdmission.mockReset();
  recoverAccountDeletionAdmission.mockResolvedValue(null);
  cancelAccountDeletion.mockClear();
});

describe("/api/public/account-deletion", () => {
  test("does not accept a query parameter as status authority", async () => {
    const response = await app.request(
      "/?credential=valid-status-capability",
      undefined,
      {
        NODE_ENV: "test",
      },
    );
    expect(response.status).toBe(401);
    expect(getAccountDeletionStatusByCredential).toHaveBeenCalledWith("");
  });

  test("returns identifier-minimal status for the exact header capability", async () => {
    const response = await app.request(
      "/",
      { headers: { "X-Account-Deletion-Status": "valid-status-capability" } },
      { NODE_ENV: "test" },
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({
      request: {
        requestId: "33333333-3333-4333-8333-333333333333",
        status: "recovery",
        canCancel: true,
      },
    });
  });

  test("rejects a cross-origin request before authentication", async () => {
    checkElizaMutatingRequestOrigin.mockReturnValueOnce({ ok: false });
    const response = await app.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation: "DELETE", admissionCredential }),
      },
      { NODE_ENV: "production" },
    );
    expect(response.status).toBe(403);
    expect(requireRecentSessionUserWithOrg).not.toHaveBeenCalled();
  });

  test("requires recent session auth and exact confirmation", async () => {
    const invalid = await app.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation: "delete" }),
      },
      { NODE_ENV: "test" },
    );
    expect(invalid.status).toBe(400);
    expect(requestAccountDeletion).not.toHaveBeenCalled();

    const accepted = await app.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation: "DELETE", admissionCredential }),
      },
      { NODE_ENV: "test" },
    );
    expect(accepted.status).toBe(202);
    expect(requestAccountDeletion).toHaveBeenCalledWith({
      userId: "11111111-1111-4111-8111-111111111111",
      organizationId: "22222222-2222-4222-8222-222222222222",
      stewardUserId: "steward-1",
      admissionCredential,
    });
  });

  test("replays a committed admission after session revocation without new provider work", async () => {
    recoverAccountDeletionAdmission.mockResolvedValueOnce({
      request: { requestId: "33333333-3333-4333-8333-333333333333", status: "reserved" },
      statusCredential: "s".repeat(43),
      recoveryCredential: "r".repeat(43),
    });
    const response = await app.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation: "DELETE", admissionCredential }),
      },
      { NODE_ENV: "test" },
    );
    expect(response.status).toBe(202);
    expect(recoverAccountDeletionAdmission).toHaveBeenCalledWith(admissionCredential);
    expect(requireRecentSessionUserWithOrg).not.toHaveBeenCalled();
    expect(requestAccountDeletion).not.toHaveBeenCalled();
  });

  test("rejects a cross-origin cancellation before recovery work", async () => {
    checkElizaMutatingRequestOrigin.mockReturnValueOnce({ ok: false });
    const response = await app.request(
      "/",
      {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          "X-Account-Deletion-Recovery": "recovery-capability",
        },
        body: JSON.stringify({ confirmation: "CANCEL DELETION" }),
      },
      { NODE_ENV: "production" },
    );
    expect(response.status).toBe(403);
    expect(cancelAccountDeletion).not.toHaveBeenCalled();
  });

  test("undo requires the separate recovery capability and exact confirmation", async () => {
    const invalidConfirmation = await app.request(
      "/",
      {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          "X-Account-Deletion-Recovery": "recovery-capability",
        },
        body: JSON.stringify({ confirmation: "cancel deletion" }),
      },
      { NODE_ENV: "test" },
    );
    expect(invalidConfirmation.status).toBe(400);
    expect(cancelAccountDeletion).not.toHaveBeenCalled();

    const canceled = await app.request(
      "/",
      {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          "X-Account-Deletion-Status": "valid-status-capability",
          "X-Account-Deletion-Recovery": "recovery-capability",
        },
        body: JSON.stringify({ confirmation: "CANCEL DELETION" }),
      },
      { NODE_ENV: "test" },
    );
    expect(canceled.status).toBe(200);
    expect(cancelAccountDeletion).toHaveBeenCalledWith("recovery-capability");
  });

  test("undo does not accept the read-only status capability", async () => {
    cancelAccountDeletion.mockRejectedValueOnce(
      new AccountDeletionRecoveryError(
        "Recovery credential is invalid",
        "STATUS_CREDENTIAL_INVALID",
      ),
    );
    const response = await app.request(
      "/",
      {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          "X-Account-Deletion-Status": "valid-status-capability",
        },
        body: JSON.stringify({ confirmation: "CANCEL DELETION" }),
      },
      { NODE_ENV: "test" },
    );
    expect(response.status).toBe(409);
    expect(cancelAccountDeletion).toHaveBeenCalledWith("");
  });
});
