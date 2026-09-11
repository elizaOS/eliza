/** Verifies tab and browser-path navigation stay one atomic shell transition. */
// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../navigation";
import { useNavigationState } from "./useNavigationState";

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("useNavigationState", () => {
  it("publishes history navigation so route-derived shell policy advances with the tab", () => {
    window.history.replaceState(null, "", "/calendar");
    const setTabRaw = vi.fn();
    const onPopState = vi.fn();
    window.addEventListener("popstate", onPopState);
    const { result } = renderHook(() =>
      useNavigationState({
        tab: "calendar" as Tab,
        setTabRaw,
        uiShellMode: "native",
        hasActiveGameRun: false,
        setAppsSubTab: vi.fn(),
      }),
    );

    act(() => result.current.setTab("chat"));

    expect(setTabRaw).toHaveBeenCalledWith("chat");
    expect(window.location.pathname).toBe("/chat");
    expect(onPopState).toHaveBeenCalledTimes(1);
    window.removeEventListener("popstate", onPopState);
  });

  it("preserves focused shell modes when startup navigation commits the initial tab", () => {
    window.history.replaceState(null, "", "/?shellMode=voice-workbench");
    const { result } = renderHook(() =>
      useNavigationState({
        tab: "chat" as Tab,
        setTabRaw: vi.fn(),
        uiShellMode: "native",
        hasActiveGameRun: false,
        setAppsSubTab: vi.fn(),
      }),
    );

    act(() => result.current.setTab("chat"));

    expect(window.location.pathname).toBe("/chat");
    expect(window.location.search).toBe("?shellMode=voice-workbench");
  });
});
