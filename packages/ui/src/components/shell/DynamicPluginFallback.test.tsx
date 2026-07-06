// @vitest-environment jsdom

/**
 * Behaviour test for the unregistered-plugin fallback (#App.tsx DynamicPluginPage
 * dead-end): it must move from a loading state to a designed error state after
 * the timeout — the loading/empty/error three-state rule — never spin forever.
 * Deterministic fake timers; no live model or network.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DynamicPluginFallback,
  UNREGISTERED_PLUGIN_TIMEOUT_MS,
} from "./DynamicPluginFallback";

describe("DynamicPluginFallback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows loading first, then degrades to a designed error state after the timeout", () => {
    render(<DynamicPluginFallback id="my-plugin" />);

    expect(screen.getByTestId("dynamic-plugin-page-loading")).toBeTruthy();
    expect(screen.queryByTestId("dynamic-plugin-page-error")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(UNREGISTERED_PLUGIN_TIMEOUT_MS + 1);
    });

    const error = screen.getByTestId("dynamic-plugin-page-error");
    expect(error.getAttribute("role")).toBe("alert");
    expect(screen.getByText("This view failed to load")).toBeTruthy();
    expect(screen.queryByTestId("dynamic-plugin-page-loading")).toBeNull();
  });

  it("keeps the loading state until the timeout deadline (registration may still arrive)", () => {
    render(<DynamicPluginFallback id="pending" timeoutMs={5_000} />);

    act(() => {
      vi.advanceTimersByTime(4_999);
    });

    expect(screen.getByTestId("dynamic-plugin-page-loading")).toBeTruthy();
    expect(screen.queryByTestId("dynamic-plugin-page-error")).toBeNull();
  });

  it("restarts the timeout when the unresolved plugin id changes", () => {
    const { rerender } = render(
      <DynamicPluginFallback id="stale-plugin" timeoutMs={5_000} />,
    );

    act(() => {
      vi.advanceTimersByTime(5_001);
    });
    expect(screen.getByTestId("dynamic-plugin-page-error")).toBeTruthy();

    rerender(<DynamicPluginFallback id="fresh-plugin" timeoutMs={5_000} />);

    expect(screen.getByTestId("dynamic-plugin-page-loading")).toBeTruthy();
    expect(screen.queryByTestId("dynamic-plugin-page-error")).toBeNull();
    expect(screen.getByText(/Loading fresh-plugin/)).toBeTruthy();
  });
});
