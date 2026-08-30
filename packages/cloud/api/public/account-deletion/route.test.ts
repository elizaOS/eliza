/** Verifies the public deletion capability recovery, activation, status, and undo boundary. */

import { beforeEach, describe, expect, mock, test } from "bun:test";

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
const recoverAccountDeletionAdmission = mock(async (credential: string) =>
  credential === "a".repeat(43)
    ? {
        request: {
          requestId: "33333333-3333-4333-8333-333333333333",
          status: "pending_activation",
        },
        statusCredential: "s".repeat(43),
        recoveryCredential: "r".repeat(43),
      }
    : null,
);
const activateAccountDeletion = mock(async (credential: string) => ({
  requestId: "33333333-3333-4333-8333-333333333333",
  status: "reserved",
  credentialAccepted: credential === "r".repeat(43),
}));
const legacyRequestAccountDeletion = mock(async () => ({
  request: {
    requestId: "33333333-3333-4333-8333-333333333333",
    status: "reserved",
  },
  statusCredential: "status-capability",
  recoveryCredential: "recovery-capability",
}));
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
  activateAccountDeletion,
  cancelAccountDeletion,
  getAccountDeletionStatusByCredential,
  recoverAccountDeletionAdmission,
  requestAccountDeletion: legacyRequestAccountDeletion,
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(() => undefined) },
}));

const { default: app } = await import("./route");

beforeEach(() => {
  checkElizaMutatingRequestOrigin.mockReset();
  checkElizaMutatingRequestOrigin.mockReturnValue({ ok: true });
  getAccountDeletionStatusByCredential.mockClear();
  recoverAccountDeletionAdmission.mockClear();
  activateAccountDeletion.mockClear();
  legacyRequestAccountDeletion.mockClear();
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

  test("rejects a cross-origin request before reading a recovery capability", async () => {
    checkElizaMutatingRequestOrigin.mockReturnValueOnce({ ok: false });
    const response = await app.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          confirmation: "DELETE",
          admissionCredential: "a".repeat(43),
        }),
      },
      { NODE_ENV: "production" },
    );
    expect(response.status).toBe(403);
    expect(recoverAccountDeletionAdmission).not.toHaveBeenCalled();
  });

  test("uses POST only to recover a committed admission receipt", async () => {
    const invalid = await app.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          confirmation: "delete",
          admissionCredential: "a".repeat(43),
        }),
      },
      { NODE_ENV: "test" },
    );
    expect(invalid.status).toBe(400);
    expect(recoverAccountDeletionAdmission).not.toHaveBeenCalled();

    const accepted = await app.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          confirmation: "DELETE",
          admissionCredential: "a".repeat(43),
        }),
      },
      { NODE_ENV: "test" },
    );
    expect(accepted.status).toBe(200);
    expect(recoverAccountDeletionAdmission).toHaveBeenCalledWith("a".repeat(43));
    expect(legacyRequestAccountDeletion).not.toHaveBeenCalled();
  });

  test("returns one generic response for malformed and unknown admission capabilities", async () => {
    for (const admissionCredential of ["short", "z".repeat(43)]) {
      const response = await app.request(
        "/",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirmation: "DELETE", admissionCredential }),
        },
        { NODE_ENV: "test" },
      );
      expect(response.status).toBe(401);
      expect((await response.json()) as unknown).toEqual({
        error: "Deletion admission credential is invalid or expired",
        code: "ADMISSION_CREDENTIAL_INVALID",
      });
    }
  });

  test("activates only after origin, recovery capability, and exact confirmation checks", async () => {
    const invalid = await app.request(
      "/",
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "X-Account-Deletion-Recovery": "r".repeat(43),
        },
        body: JSON.stringify({ confirmation: "activate deletion" }),
      },
      { NODE_ENV: "test" },
    );
    expect(invalid.status).toBe(400);
    expect(activateAccountDeletion).not.toHaveBeenCalled();

    const activated = await app.request(
      "/",
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "X-Account-Deletion-Recovery": "r".repeat(43),
        },
        body: JSON.stringify({ confirmation: "ACTIVATE DELETION" }),
      },
      { NODE_ENV: "test" },
    );
    expect(activated.status).toBe(200);
    expect(activateAccountDeletion).toHaveBeenCalledWith("r".repeat(43));
    expect((await activated.json()) as unknown).toEqual({
      request: {
        requestId: "33333333-3333-4333-8333-333333333333",
        status: "reserved",
        credentialAccepted: true,
      },
    });
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
