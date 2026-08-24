/**
 * Behavioural coverage for the @elizaos/ui/hooks barrel (src/hooks/index.ts).
 * Every subject is imported THROUGH the public barrel path exactly the way
 * package consumers import it, so a broken or circular re-export fails here
 * instead of at app runtime. Deterministic jsdom harness: fake timers plus a
 * controlled document.visibilityState; callback spies only — the hooks under
 * test are the real implementations.
 */
// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BugReportProvider,
  COMMON_SHORTCUTS,
  frameBudgetMs,
  useDocumentVisibility,
  useIntervalWhenDocumentVisible,
  useTimeout,
} from "./index";

function setHiddenDocument(): void {
  Object.defineProperty(document, "visibilityState", {
    value: "hidden",
    configurable: true,
  });
}

function setVisibleDocument(): void {
  Object.defineProperty(document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
}

function fireVisibilityChange(): void {
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  vi.useRealTimers();
  // Drop the instance-level visibilityState shadow so jsdom's prototype
  // getter ("visible") serves the next test from a clean slate.
  Reflect.deleteProperty(document, "visibilityState");
  vi.restoreAllMocks();
});

describe("useTimeout (exported through the barrel)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("fires the callback once after exactly the requested delay", () => {
    const { result } = renderHook(() => useTimeout());
    const callback = vi.fn();
    act(() => {
      result.current.setTimeout(callback, 1_000);
    });
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(callback).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(callback).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("clearSafeTimeout cancels a pending callback", () => {
    const { result } = renderHook(() => useTimeout());
    const callback = vi.fn();
    act(() => {
      const id = result.current.setTimeout(callback, 5_000);
      result.current.clearTimeout(id);
    });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(callback).not.toHaveBeenCalled();
  });

  it("clears still-pending timers on unmount so they never fire afterwards", () => {
    const { result, unmount } = renderHook(() => useTimeout());
    const callback = vi.fn();
    act(() => {
      result.current.setTimeout(callback, 1_000);
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(callback).not.toHaveBeenCalled();
  });
});

describe("useDocumentVisibility (exported through the barrel)", () => {
  it("reports an initially visible document as visible", () => {
    const { result } = renderHook(() => useDocumentVisibility());
    expect(result.current).toBe(true);
  });

  it("seeds false when mounted against an already-hidden document", () => {
    setHiddenDocument();
    const { result } = renderHook(() => useDocumentVisibility());
    expect(result.current).toBe(false);
  });

  it("tracks hidden and visible transitions via visibilitychange", () => {
    const { result } = renderHook(() => useDocumentVisibility());
    act(() => {
      setHiddenDocument();
      fireVisibilityChange();
    });
    expect(result.current).toBe(false);
    act(() => {
      setVisibleDocument();
      fireVisibilityChange();
    });
    expect(result.current).toBe(true);
  });

  it("stops listening after unmount", () => {
    const { result, unmount } = renderHook(() => useDocumentVisibility());
    unmount();
    act(() => {
      setHiddenDocument();
      fireVisibilityChange();
    });
    expect(result.current).toBe(true);
  });
});

describe("useIntervalWhenDocumentVisible (exported through the barrel)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("ticks on the requested interval while the document is visible", () => {
    const callback = vi.fn();
    renderHook(() => useIntervalWhenDocumentVisible(callback, 500));
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(callback).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(callback).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it("does not tick while hidden and resumes once visible again", () => {
    const callback = vi.fn();
    setHiddenDocument();
    renderHook(() => useIntervalWhenDocumentVisible(callback, 500));
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(callback).not.toHaveBeenCalled();
    act(() => {
      setVisibleDocument();
      fireVisibilityChange();
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(callback).toHaveBeenCalledTimes(1);
    act(() => {
      setHiddenDocument();
      fireVisibilityChange();
    });
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("never installs an interval when disabled", () => {
    const callback = vi.fn();
    renderHook(() => useIntervalWhenDocumentVisible(callback, 500, false));
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(callback).not.toHaveBeenCalled();
  });
});

describe("barrel re-export surface", () => {
  it("serves the frame-budget math through the public path", () => {
    expect(frameBudgetMs()).toBeCloseTo(1000 / 60, 10);
    expect(frameBudgetMs({ targetFps: 120 })).toBeCloseTo(1000 / 120, 10);
  });

  it("exposes a usable COMMON_SHORTCUTS catalog for consumers", () => {
    expect(Array.isArray(COMMON_SHORTCUTS)).toBe(true);
    expect(COMMON_SHORTCUTS.length).toBeGreaterThan(0);
    for (const shortcut of COMMON_SHORTCUTS) {
      expect(shortcut.id.length).toBeGreaterThan(0);
      expect(shortcut.key.length).toBeGreaterThan(0);
      expect(shortcut.description.length).toBeGreaterThan(0);
    }
  });

  it("re-exports BugReportProvider as a component-like value", () => {
    expect(typeof BugReportProvider).toBe("function");
  });
});
