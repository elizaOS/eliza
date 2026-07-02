// @vitest-environment jsdom
/**
 * Content-policy seam: Developer Mode must default OFF in ALL builds —
 * including dev builds. Vitest itself runs with `import.meta.env.DEV === true`,
 * so these tests execute under exactly the build condition that used to flip
 * the old `import.meta.env.DEV` default on; asserting "off" here proves the
 * bypass is gone, not just that production behaves.
 */
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "eliza:developerMode";

async function loadFreshModule() {
  vi.resetModules();
  return import("./useDeveloperMode");
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("useDeveloperMode content policy", () => {
  it("runs under a dev build (the exact condition of the old bypass)", () => {
    expect(import.meta.env.DEV).toBe(true);
  });

  it("defaults OFF with no persisted choice, even in a dev build", async () => {
    const mod = await loadFreshModule();
    expect(mod.isDeveloperModeEnabled()).toBe(false);
    const { result } = renderHook(() => mod.useIsDeveloperMode());
    expect(result.current).toBe(false);
  });

  it("honors a persisted ON choice at module load", async () => {
    window.localStorage.setItem(STORAGE_KEY, "1");
    const mod = await loadFreshModule();
    expect(mod.isDeveloperModeEnabled()).toBe(true);
  });

  it("honors a persisted OFF choice at module load", async () => {
    window.localStorage.setItem(STORAGE_KEY, "0");
    const mod = await loadFreshModule();
    expect(mod.isDeveloperModeEnabled()).toBe(false);
  });

  it("treats garbage storage values as the default (off)", async () => {
    window.localStorage.setItem(STORAGE_KEY, "yes-please");
    const mod = await loadFreshModule();
    expect(mod.isDeveloperModeEnabled()).toBe(false);
  });

  it("setDeveloperMode(true) persists and notifies subscribers", async () => {
    const mod = await loadFreshModule();
    const listener = vi.fn();
    // Subscribe through the public hook path.
    const { result, unmount } = renderHook(() => {
      listener();
      return mod.useIsDeveloperMode();
    });
    expect(result.current).toBe(false);

    const { act } = await import("@testing-library/react");
    act(() => mod.setDeveloperMode(true));
    expect(result.current).toBe(true);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("1");

    act(() => mod.setDeveloperMode(false));
    expect(result.current).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("0");
    unmount();
  });

  it("follows a cross-tab storage event", async () => {
    const mod = await loadFreshModule();
    const { result } = renderHook(() => mod.useIsDeveloperMode());
    expect(result.current).toBe(false);

    const { act } = await import("@testing-library/react");
    act(() => {
      window.localStorage.setItem(STORAGE_KEY, "1");
      window.dispatchEvent(
        new StorageEvent("storage", { key: STORAGE_KEY, newValue: "1" }),
      );
    });
    expect(result.current).toBe(true);
  });
});
