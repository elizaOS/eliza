/**
 * Exercises the browser synchronization hook against controlled transport
 * promises, including lifecycle refreshes that can overlap after a reconnect.
 */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SimpleViewsSnapshot } from "../types.js";

const transport = vi.hoisted(() => ({
  fetchState: vi.fn(),
  interact: vi.fn(),
  viewEvents: new Map<string, () => void>(),
  wsEvents: new Map<string, () => void>(),
}));

vi.mock("@elizaos/ui/api", () => ({
  client: {
    onWsEvent: (eventType: string, callback: () => void) => {
      transport.wsEvents.set(eventType, callback);
      return () => transport.wsEvents.delete(eventType);
    },
  },
}));

vi.mock("@elizaos/ui/events", () => ({
  VIEW_EVENTS: { VIEW_REFRESH: "view:refresh" },
  useViewEvent: (eventType: string, callback: () => void) => {
    transport.viewEvents.set(eventType, callback);
  },
}));

vi.mock("./simpleViewsData.js", () => ({
  fetchSimpleViewsState: transport.fetchState,
  interact: transport.interact,
  NOTES_UPDATED_EVENT: "view:notes:updated",
  SIMPLE_CALENDAR_UPDATED_EVENT: "view:simple-calendar:updated",
  SIMPLE_VIEWS_UPDATED_EVENT: "simple-views:state-updated",
}));

import { useSimpleViewsState } from "./useSimpleViewsState.js";

function snapshot(revision: number): SimpleViewsSnapshot {
  return {
    notes: [],
    events: [],
    selectedDate: "2026-07-15",
    revision,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

let visibilityState = "visible";

beforeEach(() => {
  transport.fetchState.mockReset();
  transport.interact.mockReset();
  transport.viewEvents.clear();
  transport.wsEvents.clear();
  visibilityState = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibilityState,
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, "visibilityState");
  vi.restoreAllMocks();
});

describe("useSimpleViewsState", () => {
  it("keeps an initial load distinct from an empty snapshot and a load error", async () => {
    const pending = deferred<SimpleViewsSnapshot>();
    transport.fetchState.mockReturnValueOnce(pending.promise);

    const { result } = renderHook(() => useSimpleViewsState());

    expect(result.current.loading).toBe(true);
    expect(result.current.snapshot).toBeNull();
    expect(result.current.error).toBeNull();

    await act(async () => {
      pending.reject(new Error("Local agent is offline"));
      await pending.promise.catch(() => undefined);
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.snapshot).toBeNull();
    expect(result.current.error).toBe("Local agent is offline");
  });

  it("recovers stale state from the client's websocket reconnect event", async () => {
    transport.fetchState.mockResolvedValueOnce(snapshot(1));
    const { result } = renderHook(() => useSimpleViewsState());
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(1));

    transport.fetchState.mockResolvedValueOnce(snapshot(4));
    act(() => transport.wsEvents.get("ws-reconnected")?.());

    await waitFor(() => expect(result.current.snapshot?.revision).toBe(4));
    expect(transport.fetchState).toHaveBeenCalledTimes(2);
  });

  it("refreshes after browser connectivity returns and only when a hidden document becomes visible", async () => {
    transport.fetchState.mockResolvedValueOnce(snapshot(1));
    const { result } = renderHook(() => useSimpleViewsState());
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(1));
    expect(transport.fetchState).toHaveBeenCalledTimes(1);

    transport.fetchState.mockResolvedValueOnce(snapshot(2));
    act(() => window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(2));

    visibilityState = "hidden";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(transport.fetchState).toHaveBeenCalledTimes(2);

    transport.fetchState.mockResolvedValueOnce(snapshot(3));
    visibilityState = "visible";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(3));
    expect(transport.fetchState).toHaveBeenCalledTimes(3);
  });

  it("converges on the newest revision when lifecycle refreshes finish out of order", async () => {
    transport.fetchState.mockResolvedValueOnce(snapshot(1));
    const { result } = renderHook(() => useSimpleViewsState());
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(1));
    expect(transport.fetchState).toHaveBeenCalledTimes(1);

    const reconnect = deferred<SimpleViewsSnapshot>();
    const visible = deferred<SimpleViewsSnapshot>();
    transport.fetchState
      .mockReturnValueOnce(reconnect.promise)
      .mockReturnValueOnce(visible.promise);

    act(() => transport.wsEvents.get("ws-reconnected")?.());
    act(() => document.dispatchEvent(new Event("visibilitychange")));

    await act(async () => {
      visible.resolve(snapshot(3));
      await visible.promise;
    });
    expect(result.current.snapshot?.revision).toBe(3);
    expect(result.current.loading).toBe(false);

    await act(async () => {
      reconnect.resolve(snapshot(2));
      await reconnect.promise;
    });
    expect(result.current.snapshot?.revision).toBe(3);
    expect(result.current.loading).toBe(false);
  });

  it("refreshes shared state after view updates or a completed chat action", async () => {
    transport.fetchState.mockResolvedValueOnce(snapshot(1));
    const { result } = renderHook(() => useSimpleViewsState());
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(1));

    transport.fetchState.mockResolvedValueOnce(snapshot(2));
    act(() => transport.viewEvents.get("view:notes:updated")?.());
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(2));

    transport.fetchState.mockResolvedValueOnce(snapshot(3));
    act(() => transport.viewEvents.get("view:simple-calendar:updated")?.());
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(3));

    transport.fetchState.mockResolvedValueOnce(snapshot(4));
    act(() => transport.viewEvents.get("view:refresh")?.());
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(4));

    expect(transport.fetchState).toHaveBeenCalledTimes(4);
  });
});
