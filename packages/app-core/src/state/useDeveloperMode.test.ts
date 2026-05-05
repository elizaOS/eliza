// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isDeveloperModeEnabled, setDeveloperMode } from "./useDeveloperMode";

describe("useDeveloperMode state", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("defaults to off when no value is stored", () => {
    expect(isDeveloperModeEnabled()).toBe(false);
  });

  it("round-trips through set/get", () => {
    setDeveloperMode(true);
    expect(isDeveloperModeEnabled()).toBe(true);

    setDeveloperMode(false);
    expect(isDeveloperModeEnabled()).toBe(false);
  });

  it("persists the setting to localStorage", () => {
    setDeveloperMode(true);
    expect(localStorage.getItem("eliza:developerMode")).toBe("1");

    setDeveloperMode(false);
    expect(localStorage.getItem("eliza:developerMode")).toBe("0");
  });

  it("notifies subscribers on change", async () => {
    const { renderHook, act } = await import("@testing-library/react");
    const { useIsDeveloperMode } = await import("./useDeveloperMode");

    const { result } = renderHook(() => useIsDeveloperMode());
    expect(result.current).toBe(false);

    act(() => {
      setDeveloperMode(true);
    });
    expect(result.current).toBe(true);

    act(() => {
      setDeveloperMode(false);
    });
    expect(result.current).toBe(false);
  });
});
