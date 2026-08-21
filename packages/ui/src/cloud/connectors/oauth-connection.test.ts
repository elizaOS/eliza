/** Verifies OAuth connect navigation guarding through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Regression coverage for the connector OAuth connect flow: the provider
 * `authUrl` is a wire value assigned to the top window, so a non-http(s)
 * value must surface the error toast instead of navigating. jsdom hook
 * render with a mocked api client; no network.
 */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("../lib/api-client", () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {},
}));

vi.mock("sonner", () => ({
  toast: { error: toastError, success: vi.fn() },
}));

import { useOAuthConnections } from "./oauth-connection";

const config = { platform: "google", label: "Google" };

beforeEach(() => {
  apiMock.mockReset();
  toastError.mockReset();
  apiMock.mockImplementation((url: string) => {
    if (url.startsWith("/api/v1/oauth/connections")) {
      return Promise.resolve({ connections: [] });
    }
    return Promise.resolve({});
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("useOAuthConnections connect", () => {
  it("navigates the top window to a valid https authorization URL", async () => {
    apiMock.mockImplementation((url: string) => {
      if (url.startsWith("/api/v1/oauth/connections")) {
        return Promise.resolve({ connections: [] });
      }
      if (url.startsWith("/api/v1/oauth/google/initiate")) {
        return Promise.resolve({
          authUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=abc",
        });
      }
      return Promise.resolve({});
    });
    // jsdom cannot perform real navigations: it logs "Not implemented" when
    // the assignment happens. Swallow exactly that log (the harness fails
    // tests on unexpected console output) and use it as the observable proof
    // that the valid wire URL did reach the top-window assignment.
    const recorder = console.error;
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        if (
          typeof args[0] === "string" &&
          args[0].includes("Not implemented: navigation")
        ) {
          return;
        }
        recorder(...args);
      });
    const { result } = renderHook(() => useOAuthConnections(config));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.connect();
    });

    expect(toastError).not.toHaveBeenCalled();
    expect(
      consoleSpy.mock.calls.some(
        (args) =>
          typeof args[0] === "string" &&
          args[0].includes("Not implemented: navigation"),
      ),
    ).toBe(true);
  });

  it("refuses a non-http(s) authorization URL instead of navigating", async () => {
    apiMock.mockImplementation((url: string) => {
      if (url.startsWith("/api/v1/oauth/connections")) {
        return Promise.resolve({ connections: [] });
      }
      if (url.startsWith("/api/v1/oauth/google/initiate")) {
        return Promise.resolve({ authUrl: "javascript:alert(1)" });
      }
      return Promise.resolve({});
    });
    const originalHref = window.location.href;
    const { result } = renderHook(() => useOAuthConnections(config));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.connect();
    });

    expect(toastError).toHaveBeenCalledWith(
      "Received an invalid Google authorization URL",
    );
    expect(window.location.href).toBe(originalHref);
    expect(result.current.isConnecting).toBe(false);
  });
});
