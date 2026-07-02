// @vitest-environment jsdom
/**
 * useAppShellState server-favorites hydration: single retry-after-ready
 * (iOS boot-warning D2 item 3).
 *
 * On iOS the first favorites fetch can fail while the native transport is
 * still mode-gated during boot. The hook must re-fetch exactly once after the
 * native agent dispatches AGENT_READY_EVENT — and must NOT re-fetch when the
 * first attempt already hydrated, when the event fires repeatedly, or after
 * unmount.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchServerFavoriteApps = vi.fn<() => Promise<string[] | null>>();
vi.mock("./persistence", () => ({
  fetchServerFavoriteApps: () => fetchServerFavoriteApps(),
  loadFavoriteApps: () => ["cached-app"],
  loadRecentApps: () => [],
  replaceServerFavoriteApps: vi.fn(async () => null),
  saveFavoriteApps: vi.fn(),
  saveRecentApps: vi.fn(),
}));
vi.mock("../api", () => ({
  client: { getBaseUrl: () => "http://127.0.0.1:31337" },
}));
vi.mock("../api/app-shell-capabilities", () => ({
  supportsFullAppShellRoutes: () => true,
}));

import { AGENT_READY_EVENT } from "../events";
import { useAppShellState } from "./useAppShellState";

function dispatchAgentReady(): void {
  document.dispatchEvent(new CustomEvent(AGENT_READY_EVENT));
}

beforeEach(() => {
  fetchServerFavoriteApps.mockReset();
  sessionStorage.clear();
});

describe("useAppShellState favorites retry-after-ready", () => {
  it("retries exactly once after agent-ready when the boot-time fetch was gated", async () => {
    fetchServerFavoriteApps
      .mockResolvedValueOnce(null) // boot: transport mode-gated
      .mockResolvedValueOnce(["server-app-a", "server-app-b"]);

    const { result } = renderHook(() => useAppShellState());
    await waitFor(() =>
      expect(fetchServerFavoriteApps).toHaveBeenCalledTimes(1),
    );
    expect(result.current.state.favoriteApps).toEqual(["cached-app"]);

    act(() => {
      dispatchAgentReady();
    });

    await waitFor(() =>
      expect(result.current.state.favoriteApps).toEqual([
        "server-app-a",
        "server-app-b",
      ]),
    );
    expect(fetchServerFavoriteApps).toHaveBeenCalledTimes(2);

    // Further agent-ready events must not trigger more fetches.
    act(() => {
      dispatchAgentReady();
      dispatchAgentReady();
    });
    await Promise.resolve();
    expect(fetchServerFavoriteApps).toHaveBeenCalledTimes(2);
  });

  it("does not re-fetch after agent-ready when the first fetch already hydrated", async () => {
    fetchServerFavoriteApps.mockResolvedValue(["server-app"]);

    const { result } = renderHook(() => useAppShellState());
    await waitFor(() =>
      expect(result.current.state.favoriteApps).toEqual(["server-app"]),
    );
    expect(fetchServerFavoriteApps).toHaveBeenCalledTimes(1);

    act(() => {
      dispatchAgentReady();
    });
    await Promise.resolve();
    expect(fetchServerFavoriteApps).toHaveBeenCalledTimes(1);
  });

  it("does not re-fetch when agent-ready fires after unmount", async () => {
    fetchServerFavoriteApps.mockResolvedValue(null);

    const { unmount } = renderHook(() => useAppShellState());
    await waitFor(() =>
      expect(fetchServerFavoriteApps).toHaveBeenCalledTimes(1),
    );

    unmount();
    act(() => {
      dispatchAgentReady();
    });
    await Promise.resolve();
    expect(fetchServerFavoriteApps).toHaveBeenCalledTimes(1);
  });
});
