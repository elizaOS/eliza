// @vitest-environment jsdom

// Covers the boot-race retry contract of loadPlugins (usePluginsSkillsState):
// during boot, runHydrating fires loadPlugins fire-and-forget while the
// dev/desktop API may still be coming up. A connection-refused there surfaces
// as a transient "Failed to fetch" — the server just isn't listening yet —
// and must NOT be reported as an error (the Dev Smoke e2e asserts zero console
// errors). A real HTTP failure, by contrast, must surface immediately with no
// retry. This test pins both branches.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getPlugins = vi.fn();
vi.mock("../api", () => ({
  client: {
    getPlugins: (...args: unknown[]) => getPlugins(...args),
  },
}));

// Keep the real ../providers and ../utils exports (notably the real
// isTransientOptionalFetchFailure) — only ../api needs to be a stub so the
// hook's client.getPlugins is controllable.
vi.mock("../providers", () => ({
  normalizeFirstRunProviderId: (id: string) => id,
}));
vi.mock("../utils", async () => {
  const actual = await vi.importActual<
    typeof import("../utils/transient-fetch")
  >("../utils/transient-fetch");
  return {
    isTransientOptionalFetchFailure: actual.isTransientOptionalFetchFailure,
    confirmDesktopAction: vi.fn(async () => true),
  };
});

const loggerError = vi.fn();
vi.mock("@elizaos/logger", async () => {
  const actual =
    await vi.importActual<typeof import("@elizaos/logger")>("@elizaos/logger");
  return {
    ...actual,
    logger: {
      ...actual.logger,
      error: (...args: unknown[]) => loggerError(...args),
    },
  };
});

import { usePluginsSkillsState } from "./usePluginsSkillsState";

const params = {
  setActionNotice: vi.fn(),
  setPendingRestart: vi.fn(),
  setPendingRestartReasons: vi.fn(),
  showRestartBanner: vi.fn(),
  triggerRestart: vi.fn(async () => {}),
};

function transientFetchError(): Error {
  const err = new TypeError("Failed to fetch");
  return err;
}

function httpError(): Error {
  const err = new Error("Internal Server Error");
  err.name = "ApiError";
  (err as Error & { kind?: string }).kind = "http";
  (err as Error & { status?: number }).status = 500;
  return err;
}

function timeoutError(): Error {
  // The dev API is briefly too slow under boot load — the request times out.
  const err = new Error("Request timed out after 10000ms");
  err.name = "ApiError";
  (err as Error & { kind?: string }).kind = "timeout";
  return err;
}

describe("loadPlugins boot-race retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getPlugins.mockReset();
    loggerError.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a transient 'Failed to fetch' and succeeds without logging an error", async () => {
    // Two boot-race rejections, then the server comes up.
    getPlugins
      .mockRejectedValueOnce(transientFetchError())
      .mockRejectedValueOnce(transientFetchError())
      .mockResolvedValueOnce({ plugins: [{ id: "p1" }] });

    const { result } = renderHook(() => usePluginsSkillsState(params));

    let done: Promise<void>;
    act(() => {
      done = result.current.loadPlugins();
    });
    // Drain the backoff timers.
    await act(async () => {
      await vi.runAllTimersAsync();
      await done;
    });

    expect(getPlugins).toHaveBeenCalledTimes(3);
    expect(loggerError).not.toHaveBeenCalled();
    expect(result.current.pluginsLoadError).toBeNull();
    expect(result.current.pluginsLoaded).toBe(true);
    expect(result.current.plugins).toEqual([{ id: "p1" }]);
  });

  it("retries a transient request timeout and succeeds without logging an error", async () => {
    // A heavy dev cold-start can blow the per-request timeout; a later poll wins.
    getPlugins
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValueOnce({ plugins: [{ id: "p2" }] });

    const { result } = renderHook(() => usePluginsSkillsState(params));

    let done: Promise<void>;
    act(() => {
      done = result.current.loadPlugins();
    });
    await act(async () => {
      await vi.runAllTimersAsync();
      await done;
    });

    expect(getPlugins).toHaveBeenCalledTimes(2);
    expect(loggerError).not.toHaveBeenCalled();
    expect(result.current.pluginsLoaded).toBe(true);
    expect(result.current.plugins).toEqual([{ id: "p2" }]);
  });

  it("surfaces a non-transient HTTP failure immediately with no retry", async () => {
    getPlugins.mockRejectedValue(httpError());

    const { result } = renderHook(() => usePluginsSkillsState(params));

    let done: Promise<void>;
    act(() => {
      done = result.current.loadPlugins();
    });
    await act(async () => {
      await vi.runAllTimersAsync();
      await done;
    });

    // No retry on a real error.
    expect(getPlugins).toHaveBeenCalledTimes(1);
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(result.current.pluginsLoadError).toBe("Internal Server Error");
    expect(result.current.pluginsLoaded).toBe(false);
  });

  it("reports an error after a persistently unreachable API (retries exhausted)", async () => {
    getPlugins.mockRejectedValue(transientFetchError());

    const { result } = renderHook(() => usePluginsSkillsState(params));

    let done: Promise<void>;
    act(() => {
      done = result.current.loadPlugins();
    });
    await act(async () => {
      await vi.runAllTimersAsync();
      await done;
    });

    expect(getPlugins).toHaveBeenCalledTimes(5);
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(result.current.pluginsLoadError).toBe("Failed to fetch");
  });
});
