/**
 * Unit tests for useExplorerApiKey — the API Explorer credential hook backed
 * by `GET /api/v1/api-keys/explorer`. Drives the real hook through the
 * package's configured test harness; only the HTTP transport (`api`) and the
 * explorer toast adapter are mocked at their module boundaries.
 */
// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api-client", () => {
  class MockApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
      public readonly body?: unknown,
    ) {
      super(message);
      this.name = "ApiError";
    }
  }
  return { ApiError: MockApiError, api: vi.fn() };
});

vi.mock("./toast", () => ({ toast: vi.fn() }));

import { ApiError, api } from "../lib/api-client";
import { toast } from "./toast";
import { type ExplorerApiKey, useExplorerApiKey } from "./use-explorer-api-key";

const apiMock = vi.mocked(api);
const toastMock = vi.mocked(toast);

const EXPLORER_PATH = "/api/v1/api-keys/explorer";
const EXPLORER_INIT = { cache: "no-store" };

function makeKey(overrides: Partial<ExplorerApiKey> = {}): ExplorerApiKey {
  return {
    id: "key-1",
    name: "API Explorer",
    description: null,
    key_prefix: "eliza_explorer_",
    key: "eliza_explorer_secret",
    created_at: "2026-08-24T00:00:00.000Z",
    is_active: true,
    usage_count: 0,
    last_used_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  apiMock.mockReset();
  toastMock.mockReset();
});

describe("useExplorerApiKey", () => {
  it("starts loading and auto-fetches the explorer endpoint on mount", async () => {
    apiMock.mockResolvedValueOnce({ apiKey: makeKey() });

    const { result } = renderHook(() => useExplorerApiKey());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.authToken).toBe("");
    expect(result.current.explorerKey).toBeNull();
    expect(result.current.error).toBeNull();

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock).toHaveBeenCalledWith(EXPLORER_PATH, EXPLORER_INIT);
    expect(result.current.error).toBeNull();
  });

  it("adopts an existing explorer key without announcing it as created", async () => {
    const existing = makeKey({ usage_count: 7 });
    apiMock.mockResolvedValueOnce({ apiKey: existing });

    const { result } = renderHook(() => useExplorerApiKey());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.explorerKey).toEqual(existing);
    expect(result.current.authToken).toBe(existing.key);
    expect(result.current.error).toBeNull();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("announces a freshly minted key with a success toast", async () => {
    const minted = makeKey({ key: "eliza_explorer_fresh" });
    apiMock.mockResolvedValueOnce({ apiKey: minted, isNew: true });

    const { result } = renderHook(() => useExplorerApiKey());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.explorerKey).toEqual(minted);
    expect(result.current.authToken).toBe(minted.key);
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith({
      message: "API Explorer key created!",
      mode: "success",
    });
  });

  it("surfaces the backend error message when the response carries no key", async () => {
    apiMock.mockResolvedValueOnce({ error: "Explorer keys are disabled" });

    const { result } = renderHook(() => useExplorerApiKey());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.explorerKey).toBeNull();
    expect(result.current.authToken).toBe("");
    expect(result.current.error).toBe("Explorer keys are disabled");
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("falls back to a generic failure message when the response has neither key nor error", async () => {
    apiMock.mockResolvedValueOnce({});

    const { result } = renderHook(() => useExplorerApiKey());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.explorerKey).toBeNull();
    expect(result.current.authToken).toBe("");
    expect(result.current.error).toBe("Failed to fetch API key");
  });

  it("maps an ApiError rejection onto the error state using its own message", async () => {
    apiMock.mockRejectedValueOnce(
      new ApiError(401, "HTTP_401", "Session expired"),
    );

    const { result } = renderHook(() => useExplorerApiKey());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe("Session expired");
    expect(result.current.explorerKey).toBeNull();
    expect(result.current.authToken).toBe("");
  });

  it("reports a connection failure for non-ApiError rejections", async () => {
    apiMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const { result } = renderHook(() => useExplorerApiKey());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe("Failed to connect to server");
    expect(result.current.explorerKey).toBeNull();
    expect(result.current.authToken).toBe("");
  });

  it("clears a previous error and adopts the fresh key when refreshExplorerKey is called", async () => {
    apiMock.mockResolvedValueOnce({ error: "transient outage" });

    const { result } = renderHook(() => useExplorerApiKey());
    await waitFor(() => expect(result.current.error).toBe("transient outage"));

    const refreshed = makeKey({ key: "eliza_explorer_second" });
    apiMock.mockResolvedValueOnce({ apiKey: refreshed });
    await act(async () => {
      await result.current.refreshExplorerKey();
    });

    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(result.current.explorerKey).toEqual(refreshed);
    expect(result.current.authToken).toBe(refreshed.key);
    expect(result.current.isLoading).toBe(false);
  });

  it("lets setAuthToken override the local token without refetching", async () => {
    const existing = makeKey();
    apiMock.mockResolvedValueOnce({ apiKey: existing });

    const { result } = renderHook(() => useExplorerApiKey());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(apiMock).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.setAuthToken("manually-entered-token");
    });

    expect(result.current.authToken).toBe("manually-entered-token");
    expect(result.current.explorerKey).toEqual(existing);
    expect(apiMock).toHaveBeenCalledTimes(1);
  });
});
