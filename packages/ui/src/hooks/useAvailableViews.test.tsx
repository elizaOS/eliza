/**
 * Exercises the shared view catalog's fetch, refresh, error, and builtin-merge behavior.
 * @vitest-environment jsdom
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitViewEvent } from "../views/view-event-bus";
import { VIEW_EVENTS } from "../views/view-event-types";
import { __resetResourceCache } from "./resource-cache";
import {
  useAvailableViews,
  useRoutableViews,
  type ViewRegistryEntry,
  withBuiltinShellViews,
} from "./useAvailableViews";

const { client, fetchWithCsrf, getFrontendPlatform } = vi.hoisted(() => ({
  client: {
    getBaseUrl: vi.fn(() => ""),
  },
  fetchWithCsrf: vi.fn(),
  getFrontendPlatform: vi.fn(() => "desktop"),
}));

vi.mock("../api", () => ({ client }));
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
    __resetResourceCache();
    client.getBaseUrl.mockReturnValue("");
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

  it("does not fetch or poll views when network access is disabled", async () => {
    vi.useFakeTimers();

    const { result } = renderHook(() =>
      useAvailableViews({ networkEnabled: false }),
    );

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.views).toEqual([]);
    expect(fetchWithCsrf).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(30_000);
      result.current.refresh();
    });
    await flushHookEffects();

    expect(fetchWithCsrf).not.toHaveBeenCalled();
  });

  it("does not fetch app-shell views from a limited cloud agent base", async () => {
    vi.useFakeTimers();
    client.getBaseUrl.mockReturnValue(
      "https://37911a1e-ed40-4626-88f5-0e4dcf249a34.elizacloud.ai",
    );

    const { result } = renderHook(() => useAvailableViews());

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(fetchWithCsrf).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(fetchWithCsrf).not.toHaveBeenCalled();
  });

  it("fetches shipped registry views with the platform header and merges by view type/id", async () => {
    fetchWithCsrf.mockResolvedValueOnce(
      response(200, {
        views: [
          view("wallet", { viewType: "gui", label: "Wallet GUI" }),
          view("shared", { label: "Shared GUI" }),
          view("spatial-room", { viewType: "xr", label: "Spatial" }),
        ],
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
    ).toEqual(["gui:wallet", "gui:shared", "xr:spatial-room"]);
    expect(fetchWithCsrf).toHaveBeenNthCalledWith(1, "/api/views", {
      headers: { "X-Eliza-Platform": "desktop" },
    });
    expect(fetchWithCsrf).toHaveBeenCalledTimes(1);
  });

  it("accepts the current view-capability transport contract", async () => {
    fetchWithCsrf.mockResolvedValueOnce(
      response(200, {
        views: [
          view("birdclaw", {
            capabilities: [
              {
                id: "get-state",
                description: "Read the mounted view state.",
              },
            ],
          }),
        ],
      }),
    );

    const { result } = renderHook(() => useAvailableViews());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeNull();
    expect(result.current.views).toEqual([
      expect.objectContaining({
        id: "birdclaw",
        capabilities: [
          {
            id: "get-state",
            description: "Read the mounted view state.",
          },
        ],
      }),
    ]);
  });

  it("strips views declaring `nativeOs: true` off the AOSP fork", async () => {
    fetchWithCsrf.mockResolvedValueOnce(
      response(200, {
        views: [
          view("phone", { nativeOs: true }),
          view("messages", { nativeOs: true }),
          view("contacts", { nativeOs: true }),
          view("camera", { nativeOs: true }),
          view("wallet"),
        ],
      }),
    );

    const { result } = renderHook(() => useAvailableViews());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // jsdom has no ElizaOS UA marker → not the AOSP fork → natives stripped.
    expect(result.current.views.map((v) => v.id)).toEqual(["wallet"]);
  });

  it("gates on the declared `nativeOs` flag, not the view id", async () => {
    // A view id-matching an old native surface but WITHOUT the flag survives;
    // a plugin-owned view declaring the flag is stripped. Proves the filter is
    // declaration-driven rather than a hardcoded id set.
    fetchWithCsrf.mockResolvedValueOnce(
      response(200, {
        views: [
          view("phone"),
          view("some-plugin-native-app", { nativeOs: true }),
          view("wallet"),
        ],
      }),
    );

    const { result } = renderHook(() => useAvailableViews());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.views.map((v) => v.id).sort()).toEqual([
      "phone",
      "wallet",
    ]);
  });

  it("keeps native-OS views on the AOSP fork (?android=true)", async () => {
    window.history.replaceState(null, "", "/?android=true");
    fetchWithCsrf.mockResolvedValueOnce(
      response(200, {
        views: [view("phone", { nativeOs: true }), view("wallet")],
      }),
    );

    const { result } = renderHook(() => useAvailableViews());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.views.map((v) => v.id).sort()).toEqual([
      "phone",
      "wallet",
    ]);
    window.history.replaceState(null, "", "/");
  });

  it("preserves retained modality metadata returned by the default registry", async () => {
    fetchWithCsrf.mockResolvedValueOnce(
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
    fetchWithCsrf.mockResolvedValueOnce(
      response(200, {
        views: [
          view("duplicate", { label: "Old label" }),
          view("duplicate", { label: "New label" }),
        ],
      }),
    );

    const { result } = renderHook(() => useAvailableViews());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.views).toEqual([
      expect.objectContaining({ id: "duplicate", label: "New label" }),
    ]);
  });

  it("surfaces malformed payloads instead of rendering a healthy empty list", async () => {
    fetchWithCsrf.mockResolvedValueOnce(response(200, { ok: true }));

    const { result } = renderHook(() => useAvailableViews());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.views).toEqual([]);
    expect(result.current.error).toMatchObject({
      name: "ElizaError",
      code: "VIEW_REGISTRY_RESPONSE_INVALID",
    });
  });

  it("adds built-in shell entries only for routable consumers", async () => {
    fetchWithCsrf.mockResolvedValue(response(200, { views: [] }));

    const available = renderHook(() => useAvailableViews());
    await waitFor(() => expect(available.result.current.loading).toBe(false));
    expect(
      available.result.current.views.find((v) => v.id === "documents"),
    ).toBe(undefined);
    available.unmount();

    const routable = renderHook(() => useRoutableViews());
    await waitFor(() => expect(routable.result.current.loading).toBe(false));

    expect(routable.result.current.views).toContainEqual(
      expect.objectContaining({
        id: "documents",
        path: "/character/documents",
        builtin: true,
        visibleInManager: false,
        desktopTabEnabled: true,
      }),
    );
  });

  it("does not let built-in shell fallbacks override real registry entries", () => {
    const routable = withBuiltinShellViews([
      view("documents", {
        label: "Registered Documents",
        path: "/apps/registered-documents",
        pluginName: "@elizaos/plugin-documents",
      }),
    ]);

    expect(routable.find((v) => v.id === "documents")).toMatchObject({
      id: "documents",
      label: "Registered Documents",
      path: "/apps/registered-documents",
      pluginName: "@elizaos/plugin-documents",
    });
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

  it("keeps the latest refresh result when an older request resolves last", async () => {
    const staleGui = deferredResponse();
    const freshGui = deferredResponse();
    fetchWithCsrf
      .mockReturnValueOnce(staleGui.promise)
      .mockReturnValueOnce(freshGui.promise);

    const { result } = renderHook(() => useAvailableViews());

    act(() => {
      result.current.refresh();
    });
    freshGui.resolve(response(200, { views: [view("fresh")] }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.views[0]?.id).toBe("fresh");

    staleGui.resolve(response(200, { views: [view("stale")] }));
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
      .mockResolvedValueOnce(response(200, { views: [view("second")] }))
      .mockResolvedValueOnce(response(200, { views: [view("third")] }));

    const { result, unmount } = renderHook(() => useAvailableViews());
    await flushHookEffects();
    expect(result.current.views[0]?.id).toBe("first");

    act(() => {
      result.current.refresh();
    });
    await flushHookEffects();
    expect(result.current.views[0]?.id).toBe("second");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await flushHookEffects();
    expect(result.current.views[0]?.id).toBe("third");
    expect(fetchWithCsrf).toHaveBeenCalledTimes(3);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchWithCsrf).toHaveBeenCalledTimes(3);
  });

  it("refreshes the shared registry immediately after a plugin create/edit reload", async () => {
    fetchWithCsrf
      .mockResolvedValueOnce(
        response(200, {
          views: [
            view("notes", {
              bundleUrl: "/api/views/notes/bundle.js?v=before",
            }),
          ],
        }),
      )
      .mockResolvedValueOnce(
        response(200, {
          views: [
            view("notes", {
              bundleUrl: "/api/views/notes/bundle.js?v=after",
            }),
            view("new-dashboard"),
          ],
        }),
      );

    // App mounts one consumer for routing and another for desktop tabs. The
    // plugin event must refresh their shared cache once, not race two reads.
    const router = renderHook(() => useAvailableViews());
    const tabs = renderHook(() => useAvailableViews());
    await waitFor(() => expect(router.result.current.loading).toBe(false));
    expect(fetchWithCsrf).toHaveBeenCalledTimes(1);

    act(() => {
      emitViewEvent(
        VIEW_EVENTS.PLUGIN_RELOADED,
        { pluginName: "test-plugin" },
        "agent",
      );
    });

    await waitFor(() =>
      expect(router.result.current.views).toEqual([
        expect.objectContaining({
          id: "notes",
          bundleUrl: "/api/views/notes/bundle.js?v=after",
        }),
        expect.objectContaining({ id: "new-dashboard" }),
      ]),
    );
    expect(tabs.result.current.views).toEqual(router.result.current.views);
    expect(fetchWithCsrf).toHaveBeenCalledTimes(2);
  });

  it("runs only one background poll when the hook is mounted twice", async () => {
    vi.useFakeTimers();
    // Two simultaneous mounts (App.tsx mounts the hook in ViewRouter and again
    // in the shell). They share one cache key, so they must share one poll timer
    // — a single 5s tick should issue exactly one registry fetch, not two.
    fetchWithCsrf.mockResolvedValue(response(200, { views: [] }));

    const first = renderHook(() => useAvailableViews());
    const second = renderHook(() => useAvailableViews());
    await flushHookEffects();

    // Initial mount fetch is shared (one in-flight round across both mounts).
    expect(fetchWithCsrf).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await flushHookEffects();

    // One poll tick -> one extra fetch, not two.
    expect(fetchWithCsrf).toHaveBeenCalledTimes(2);

    // With one mount unmounted, the surviving mount keeps the single timer alive.
    first.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await flushHookEffects();
    expect(fetchWithCsrf).toHaveBeenCalledTimes(3);

    // Last unmount tears the timer down — no further polling.
    second.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchWithCsrf).toHaveBeenCalledTimes(3);
  });

  it("pauses background polling while hidden and refreshes when visible again", async () => {
    vi.useFakeTimers();
    fetchWithCsrf.mockResolvedValue(response(200, { views: [] }));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });

    const { unmount } = renderHook(() => useAvailableViews());
    await flushHookEffects();
    expect(fetchWithCsrf).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await flushHookEffects();
    expect(fetchWithCsrf).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await flushHookEffects();
    expect(fetchWithCsrf).toHaveBeenCalledTimes(2);

    unmount();
  });
});
