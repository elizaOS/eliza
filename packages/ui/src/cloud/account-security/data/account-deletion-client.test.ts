/** Verifies that account-deletion transport data is validated before the UI trusts it. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/api-client", () => ({ api: apiMock }));

import {
  getAccountDeletionStatus,
  submitAccountDeletion,
} from "./account-deletion-client";

beforeEach(() => apiMock.mockReset());

describe("getAccountDeletionStatus", () => {
  it("accepts each fail-closed availability state", async () => {
    apiMock.mockResolvedValueOnce({
      state: "lifecycle_unavailable",
      request: null,
      code: "LIFECYCLE_RESERVATION_REQUIRED",
      message: "Lifecycle reservation required",
    });

    await expect(getAccountDeletionStatus()).resolves.toMatchObject({
      state: "lifecycle_unavailable",
      request: null,
    });
    expect(apiMock).toHaveBeenCalledWith("/api/v1/me/account-deletion");
  });

  it("accepts a complete existing receipt", async () => {
    apiMock.mockResolvedValueOnce({
      state: "existing_request",
      request: {
        requestId: "request-1",
        status: "action_required",
        requestedAt: "2026-08-19T00:00:00.000Z",
        scheduledDeletionAt: "2026-09-18T00:00:00.000Z",
        identityDeactivated: false,
        completedAt: null,
      },
    });

    await expect(getAccountDeletionStatus()).resolves.toMatchObject({
      state: "existing_request",
      request: { requestId: "request-1", identityDeactivated: false },
    });
  });

  it("rejects unknown states and incomplete receipts", async () => {
    apiMock.mockResolvedValueOnce({ state: "scheduled", request: null });
    await expect(getAccountDeletionStatus()).rejects.toThrow(
      "Account deletion availability response was malformed",
    );

    apiMock.mockResolvedValueOnce({
      state: "existing_request",
      request: { requestId: "request-1" },
    });
    await expect(getAccountDeletionStatus()).rejects.toThrow(
      "Account deletion receipt was malformed",
    );
  });
});

describe("submitAccountDeletion", () => {
  const validRequest = {
    requestId: "request-1",
    status: "scheduled",
    requestedAt: "2026-08-19T00:00:00.000Z",
    scheduledDeletionAt: "2026-09-18T00:00:00.000Z",
    identityDeactivated: true,
    completedAt: null,
  };

  it("validates and returns a complete deletion receipt", async () => {
    apiMock.mockResolvedValueOnce({ request: validRequest });

    await expect(submitAccountDeletion()).resolves.toEqual(validRequest);
    expect(apiMock).toHaveBeenCalledWith("/api/v1/me/account-deletion", {
      method: "POST",
      json: { confirmation: "DELETE" },
    });
  });

  it("rejects malformed response envelopes and unknown statuses", async () => {
    apiMock.mockResolvedValueOnce(null);
    await expect(submitAccountDeletion()).rejects.toThrow(
      "Account deletion response was malformed",
    );

    apiMock.mockResolvedValueOnce({
      request: { ...validRequest, status: "unexpected" },
    });
    await expect(submitAccountDeletion()).rejects.toThrow(
      "Account deletion receipt was malformed",
    );
  });

  it("rejects invalid receipt dates", async () => {
    apiMock.mockResolvedValueOnce({
      request: { ...validRequest, scheduledDeletionAt: "not-a-date" },
    });
    await expect(submitAccountDeletion()).rejects.toThrow(
      "Account deletion receipt was malformed",
    );

    apiMock.mockResolvedValueOnce({
      request: { ...validRequest, completedAt: "2026-09-18" },
    });
    await expect(submitAccountDeletion()).rejects.toThrow(
      "Account deletion receipt was malformed",
    );
  });
});
