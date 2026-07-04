// @vitest-environment jsdom

/**
 * The AppContext selector store (`app-store`): field-level subscriptions via
 * `useAppSelector` / `useAppSelectorShallow` and the shallow-equality gate that
 * suppresses re-renders. Real hooks under jsdom; no live model.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __appShallowEqual,
  __setAppValueForTests,
  publishAppValue,
  useAppSelector,
  useAppSelectorShallow,
} from "./app-store";
import type { AppContextValue } from "./internal";

// Tests build partial values; the store never inspects unselected fields, so a
// contained cast through a single factory is sufficient (and keeps the cast out
// of the hooks under test).
function makeValue(partial: Record<string, unknown>): AppContextValue {
  return partial as unknown as AppContextValue;
}

afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
});

describe("useAppSelector", () => {
  it("selects a slice of the published value", () => {
    __setAppValueForTests(makeValue({ tab: "chat", uiLanguage: "en" }));
    const { result } = renderHook(() =>
      useAppSelector((s) => s.tab as unknown as string),
    );
    expect(result.current).toBe("chat");
  });

  it("re-renders only when the SELECTED slice changes, not on unrelated fields", () => {
    __setAppValueForTests(makeValue({ tab: "chat", logs: [] }));
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useAppSelector((s) => s.tab as unknown as string);
    });
    expect(result.current).toBe("chat");
    const initial = renders;

    // Unrelated field changes (a new value identity, like a log poll) → no
    // re-render, because the selected slice (tab) is unchanged.
    act(() => {
      publishAppValue(makeValue({ tab: "chat", logs: [{ msg: "x" }] }));
    });
    expect(renders).toBe(initial);
    expect(result.current).toBe("chat");

    // The selected field changes → exactly one re-render.
    act(() => {
      publishAppValue(makeValue({ tab: "settings", logs: [{ msg: "x" }] }));
    });
    expect(renders).toBe(initial + 1);
    expect(result.current).toBe("settings");
  });

  it("useAppSelectorShallow bails out on a fresh-but-equal object slice", () => {
    __setAppValueForTests(makeValue({ a: 1, b: 2, unrelated: 0 }));
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useAppSelectorShallow((s) => ({
        a: (s as unknown as { a: number }).a,
        b: (s as unknown as { b: number }).b,
      }));
    });
    expect(result.current).toEqual({ a: 1, b: 2 });
    const initial = renders;

    // New value identity, same {a,b} → shallow-equal → no re-render.
    act(() => {
      publishAppValue(makeValue({ a: 1, b: 2, unrelated: 99 }));
    });
    expect(renders).toBe(initial);

    // {a} changes → one re-render with the new object.
    act(() => {
      publishAppValue(makeValue({ a: 5, b: 2, unrelated: 99 }));
    });
    expect(renders).toBe(initial + 1);
    expect(result.current).toEqual({ a: 5, b: 2 });
  });

  it("recomputes when the selector changes while the store value identity is unchanged", () => {
    __setAppValueForTests(makeValue({ a: "first", b: "second" }));

    const { result, rerender } = renderHook<string, { keyName: "a" | "b" }>(
      ({ keyName }) =>
        useAppSelector(
          (s) => (s as unknown as Record<"a" | "b", string>)[keyName],
        ),
      { initialProps: { keyName: "a" } },
    );

    expect(result.current).toBe("first");

    rerender({ keyName: "b" });

    expect(result.current).toBe("second");
  });

  it("unsubscribes on unmount", () => {
    __setAppValueForTests(makeValue({ tab: "chat" }));
    const spy = vi.fn(() => useAppSelector((s) => s.tab as unknown as string));
    const { unmount } = renderHook(spy);
    const before = spy.mock.calls.length;
    unmount();
    act(() => {
      publishAppValue(makeValue({ tab: "settings" }));
    });
    // No further calls after unmount.
    expect(spy.mock.calls.length).toBe(before);
  });
});

describe("__appShallowEqual", () => {
  it("compares one level deep", () => {
    expect(__appShallowEqual({ a: 1 }, { a: 1 })).toBe(true);
    expect(__appShallowEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(__appShallowEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(__appShallowEqual(1, 1)).toBe(true);
    expect(__appShallowEqual(null, null)).toBe(true);
    expect(__appShallowEqual({ a: 1 }, null)).toBe(false);
  });
});
