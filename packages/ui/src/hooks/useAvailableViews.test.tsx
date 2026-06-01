// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAvailableViews, type ViewRegistryEntry } from "./useAvailableViews";

const { fetchWithCsrf, getFrontendPlatform } = vi.hoisted(() => ({
  fetchWithCsrf: vi.fn(),
  getFrontendPlatform: vi.fn(() => "desktop"),
}));

vi.mock("../api/csrf-client", () => ({ fetchWithCsrf }));
vi.mock("../platform/platform-guards", () => ({ getFrontendPlatform }));

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function view(
  id: string,
  patch: Partial<ViewRegistryEntry> = {},
): ViewRegistryEntry {
  return {
    id,
    label: id,
    available: true,
    pluginName: "test-plugin",
    ...patch,
  };
}

describe("useAvailableViews", () => {
  beforeEach(() => {
    fetchWithCsrf.mockReset();
    getFrontendPlatform.mockReset();
    getFrontendPlatform.mockReturnValue("desktop");
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  async function flushHookEffects() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("fetches GUI, TUI, and XR views with the platform header and merges by view type/id", async () => {
    fetchWithCsrf
      .mockResolvedValueOnce(
        response(200, {
          views: [
            view("wallet", { viewType: "gui", label: "Wallet GUI" }),
            view("shared", { label: "Shared GUI" }),
          ],
        }),
      )
      .mockResolvedValueOnce(
        response(200, {
          views: [
            view("wallet", { viewType: "tui", label: "Wallet TUI" }),
            view("not-tui", { viewType: "gui", label: "Filtered GUI" }),
          ],
        }),
      )
      .mockResolvedValueOnce(
        response(200, {
          views: [view("spatial-room", { viewType: "xr", label: "Spatial" })],
        }),
      );

    const { result } = renderHook(() => useAvailableViews());

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeNull();
    expect(
      result.current.views.map(
        (item) => `${item.viewType ?? "gui"}:${item.id}`,
      ),
    ).toEqual(["gui:wallet", "gui:shared", "tui:wallet", "xr:spatial-room"]);
    expect(fetchWithCsrf).toHaveBeenNthCalledWith(1, "/api/views", {
      headers: { "X-Eliza-Platform": "desktop" },
    });
    expect(fetchWithCsrf).toHaveBeenNthCalledWith(
      2,
      "/api/views?viewType=tui",
      {
        headers: { "X-Eliza-Platform": "desktop" },
      },
    );
    expect(fetchWithCsrf).toHaveBeenNthCalledWith(3, "/api/views?viewType=xr", {
      headers: { "X-Eliza-Platform": "desktop" },
    });
  });

  it("keeps XR views returned by the explicit XR registry endpoint", async () => {
    fetchWithCsrf
      .mockResolvedValueOnce(response(200, { views: [] }))
      .mockResolvedValueOnce(response(200, { views: [] }))
      .mockResolvedValueOnce(
        response(200, {
          views: [view("spatial-room", { viewType: "xr", label: "Spatial" })],
        }),
      );

    const { result } = renderHook(() => useAvailableViews());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.views).toEqual([
      expect.objectContaining({
        id: "spatial-room",
        viewType: "xr",
        label: "Spatial",
      }),
    ]);
  });

  it("dedupes repeated GUI entries and lets the later entry win", async () => {
    fetchWithCsrf
      .mockResolvedValueOnce(
        response(200, {
          views: [
            view("duplicate", { label: "Old label" }),
            view("duplicate", { label: "New label" }),
          ],
        }),
      )
      .mockResolvedValueOnce(response(200, { views: [] }))
      .mockResolvedValueOnce(response(200, { views: [] }));

    const { result } = renderHook(() => useAvailableViews());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.views).toEqual([
      expect.objectContaining({ id: "duplicate", label: "New label" }),
    ]);
  });

  it("treats malformed payloads as empty lists", async () => {
    fetchWithCsrf
      .mockResolvedValueOnce(response(200, { ok: true }))
      .mockResolvedValueOnce(response(200, { views: "not-an-array" }))
      .mockResolvedValueOnce(response(200, { views: [] }));

    const { result } = renderHook(() => useAvailableViews());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.views).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("silences 404s and clears views without surfacing an error", async () => {
    fetchWithCsrf.mockResolvedValue(response(404, { error: "missing" }));

    const { result } = renderHook(() => useAvailableViews());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.views).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("surfaces non-404 failures", async () => {
    fetchWithCsrf.mockResolvedValue(response(500, { error: "boom" }));

    const { result } = renderHook(() => useAvailableViews());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.views).toEqual([]);
    expect(result.current.error?.message).toContain("HTTP 500");
  });

  it("keeps successful GUI views when the TUI endpoint fails", async () => {
    fetchWithCsrf
      .mockResolvedValueOnce(response(200, { views: [view("wallet")] }))
      .mockResolvedValueOnce(response(500, { error: "tui down" }))
      .mockResolvedValueOnce(response(200, { views: [] }));

    const { result } = renderHook(() => useAvailableViews());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeNull();
    expect(result.current.views).toEqual([
      expect.objectContaining({ id: "wallet" }),
    ]);
  });

  it("keeps successful TUI views when the GUI endpoint fails", async () => {
    fetchWithCsrf
      .mockResolvedValueOnce(response(500, { error: "gui down" }))
      .mockResolvedValueOnce(
        response(200, {
          views: [view("terminal", { viewType: "tui" })],
        }),
      )
      .mockResolvedValueOnce(response(200, { views: [] }));

    const { result } = renderHook(() => useAvailableViews());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeNull();
    expect(result.current.views).toEqual([
      expect.objectContaining({ id: "terminal", viewType: "tui" }),
    ]);
  });

  it("keeps the latest refresh result when an older request resolves last", async () => {
    const staleGui = deferredResponse();
    const staleTui = deferredResponse();
    const staleXr = deferredResponse();
    const freshGui = deferredResponse();
    const freshTui = deferredResponse();
    const freshXr = deferredResponse();
    fetchWithCsrf
      .mockReturnValueOnce(staleGui.promise)
      .mockReturnValueOnce(staleTui.promise)
      .mockReturnValueOnce(staleXr.promise)
      .mockReturnValueOnce(freshGui.promise)
      .mockReturnValueOnce(freshTui.promise)
      .mockReturnValueOnce(freshXr.promise);

    const { result } = renderHook(() => useAvailableViews());

    act(() => result.current.refresh());
    freshGui.resolve(response(200, { views: [view("fresh")] }));
    freshTui.resolve(response(200, { views: [] }));
    freshXr.resolve(response(200, { views: [] }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.views[0]?.id).toBe("fresh");

    staleGui.resolve(response(200, { views: [view("stale")] }));
    staleTui.resolve(response(200, { views: [] }));
    staleXr.resolve(response(200, { views: [] }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.views[0]?.id).toBe("fresh");
  });

  it("refreshes immediately and polls until unmounted", async () => {
    vi.useFakeTimers();
    fetchWithCsrf
      .mockResolvedValueOnce(response(200, { views: [view("first")] }))
      .mockResolvedValueOnce(response(200, { views: [] }))
      .mockResolvedValueOnce(response(200, { views: [] }))
      .mockResolvedValueOnce(response(200, { views: [view("second")] }))
      .mockResolvedValueOnce(response(200, { views: [] }))
      .mockResolvedValueOnce(response(200, { views: [] }))
      .mockResolvedValueOnce(response(200, { views: [view("third")] }))
      .mockResolvedValueOnce(response(200, { views: [] }))
      .mockResolvedValueOnce(response(200, { views: [] }));

    const { result, unmount } = renderHook(() => useAvailableViews());
    await flushHookEffects();
    expect(result.current.views[0]?.id).toBe("first");

    act(() => result.current.refresh());
    await flushHookEffects();
    expect(result.current.views[0]?.id).toBe("second");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await flushHookEffects();
    expect(result.current.views[0]?.id).toBe("third");
    expect(fetchWithCsrf).toHaveBeenCalledTimes(9);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchWithCsrf).toHaveBeenCalledTimes(9);
  });
});
