// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Three-state contract for the shared cloud-connector status probe
 * (#12784/#13419).
 *
 * Before this fix a FAILED status fetch (transport / 5xx / parse / auth) left
 * `status` at `null` with only a transient toast, so every connector surface
 * rendered its "disconnected" setup form — visually identical to a genuinely
 * unconfigured connector even though the backend was unreachable. These tests
 * pin that a probe failure is now a DISTINGUISHABLE error state (`isError` +
 * `errorMessage`) that a healthy "not connected" response can never be mistaken
 * for, and that a later successful retry clears it.
 */

// The hook throws `ApiError` from the shared client on non-2xx; give the mock a
// real subclass so the `instanceof ApiError` branch (which reads `.message`) is
// exercised, not just the generic `Error` fallback. Built via `vi.hoisted` so
// the class + spies exist before the hoisted `vi.mock` factories run.
const { MockApiError, apiMock, toastErrorMock } = vi.hoisted(() => {
  class MockApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "ApiError";
    }
  }
  return { MockApiError, apiMock: vi.fn(), toastErrorMock: vi.fn() };
});

vi.mock("../lib/api-client", () => ({
  api: (...args: unknown[]) => apiMock(...args),
  ApiError: MockApiError,
}));

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

import { useConnectionStatus } from "./use-connection-status";

interface FakeStatus {
  connected: boolean;
}

beforeEach(() => {
  apiMock.mockReset();
  toastErrorMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useConnectionStatus — three-state probe (#12784/#13419)", () => {
  it("resolves a successful probe into a readable status with NO error state", async () => {
    apiMock.mockResolvedValueOnce({ connected: true });

    const { result } = renderHook(() =>
      useConnectionStatus<FakeStatus>("/api/v1/twilio/status"),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.status).toEqual({ connected: true });
    expect(result.current.isError).toBe(false);
    expect(result.current.errorMessage).toBeNull();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("surfaces a distinguishable ERROR state (not a fabricated disconnected) when the probe fails", async () => {
    apiMock.mockRejectedValueOnce(
      new MockApiError(503, "HTTP_503", "Service Unavailable"),
    );

    const { result } = renderHook(() =>
      useConnectionStatus<FakeStatus>("/api/v1/twilio/status"),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // The regression this guards: a failed probe MUST NOT leave the caller
    // reading `status === null` as a healthy "not connected".
    expect(result.current.isError).toBe(true);
    expect(result.current.errorMessage).toBe("Service Unavailable");
    expect(result.current.status).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith("Service Unavailable");
  });

  it("falls back to the provided default message for a non-ApiError failure", async () => {
    apiMock.mockRejectedValueOnce(new Error(""));

    const { result } = renderHook(() =>
      useConnectionStatus<FakeStatus>(
        "/api/v1/whatsapp/status",
        "Failed to fetch WhatsApp status",
      ),
    );

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.errorMessage).toBe("Failed to fetch WhatsApp status");
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Failed to fetch WhatsApp status",
    );
  });

  it("clears the error state after a successful retry", async () => {
    apiMock.mockRejectedValueOnce(new MockApiError(500, "HTTP_500", "boom"));

    const { result } = renderHook(() =>
      useConnectionStatus<FakeStatus>("/api/v1/twilio/status"),
    );

    await waitFor(() => expect(result.current.isError).toBe(true));

    apiMock.mockResolvedValueOnce({ connected: false });
    await act(async () => {
      await result.current.refetch();
    });

    // A healthy "not connected" (connected:false) is a real status, NOT an
    // error — the surface leaves the error state and renders the setup form.
    expect(result.current.isError).toBe(false);
    expect(result.current.errorMessage).toBeNull();
    expect(result.current.status).toEqual({ connected: false });
  });
});
