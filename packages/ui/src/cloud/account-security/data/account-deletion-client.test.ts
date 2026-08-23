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
  it("returns the parsed receipt from a complete envelope", async () => {
    apiMock.mockResolvedValueOnce({
      request: {
        requestId: "request-2",
        status: "scheduled",
        requestedAt: "2026-08-19T00:00:00.000Z",
        scheduledDeletionAt: "2026-09-18T00:00:00.000Z",
        identityDeactivated: true,
        completedAt: null,
      },
    });

    await expect(submitAccountDeletion()).resolves.toEqual({
      requestId: "request-2",
      status: "scheduled",
      requestedAt: "2026-08-19T00:00:00.000Z",
      scheduledDeletionAt: "2026-09-18T00:00:00.000Z",
      identityDeactivated: true,
      completedAt: null,
    });
    expect(apiMock).toHaveBeenCalledWith("/api/v1/me/account-deletion", {
      method: "POST",
      json: { confirmation: "DELETE" },
    });
  });

  it("rejects a malformed receipt instead of surfacing undefined fields", async () => {
    apiMock.mockResolvedValueOnce({ request: { requestId: "request-2" } });
    await expect(submitAccountDeletion()).rejects.toThrow(
      "Account deletion receipt was malformed",
    );

    apiMock.mockResolvedValueOnce({ requestId: "request-2" });
    await expect(submitAccountDeletion()).rejects.toThrow(
      "Account deletion receipt was malformed",
    );

    apiMock.mockResolvedValueOnce("accepted");
    await expect(submitAccountDeletion()).rejects.toThrow(
      "Account deletion receipt was malformed",
    );
  });

  it("rejects unknown receipt statuses and invalid timestamps", async () => {
    const request = {
      requestId: "request-2",
      status: "scheduled",
      requestedAt: "2026-08-19T00:00:00.000Z",
      scheduledDeletionAt: "2026-09-18T00:00:00.000Z",
      identityDeactivated: true,
      completedAt: null,
    };

    apiMock.mockResolvedValueOnce({
      request: { ...request, status: "unexpected" },
    });
    await expect(submitAccountDeletion()).rejects.toThrow(
      "Account deletion receipt was malformed",
    );

    apiMock.mockResolvedValueOnce({
      request: { ...request, scheduledDeletionAt: "not-a-date" },
    });
    await expect(submitAccountDeletion()).rejects.toThrow(
      "Account deletion receipt was malformed",
    );

    apiMock.mockResolvedValueOnce({
      request: { ...request, completedAt: "2026-09-18" },
    });
    await expect(submitAccountDeletion()).rejects.toThrow(
      "Account deletion receipt was malformed",
    );
  });
});
