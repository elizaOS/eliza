/**
 * Verifies the Vault modal trigger surface - the window-event dispatchers
 * and useSecretsManagerModalState - through the package's configured
 * test harness.
 */
// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dispatchSecretsManagerClose,
  dispatchSecretsManagerOpen,
  dispatchSecretsManagerToggle,
  useSecretsManagerModalState,
  type VaultTab,
} from "./useSecretsManagerModal";

const TOGGLE_EVENT = "eliza:secrets-manager-toggle";

afterEach(cleanup);

function openViaEvent(
  options?: Parameters<typeof dispatchSecretsManagerOpen>[0],
): void {
  act(() => {
    dispatchSecretsManagerOpen(options);
  });
}

function closeViaEvent(): void {
  act(() => {
    dispatchSecretsManagerClose();
  });
}

function toggleViaEvent(tab?: VaultTab): void {
  act(() => {
    dispatchSecretsManagerToggle(tab);
  });
}

describe("useSecretsManagerModalState", () => {
  it("starts closed with no tab or focus targets", () => {
    const { result } = renderHook(() => useSecretsManagerModalState());
    expect(result.current.isOpen).toBe(false);
    expect(result.current.initialTab).toBeNull();
    expect(result.current.focusKey).toBeNull();
    expect(result.current.focusProfileId).toBeNull();
  });

  it("open(), close() and setOpen() drive the flag without inventing focus params", () => {
    const { result } = renderHook(() => useSecretsManagerModalState());

    act(() => {
      result.current.open();
    });
    expect(result.current.isOpen).toBe(true);
    expect(result.current.initialTab).toBeNull();

    act(() => {
      result.current.close();
    });
    expect(result.current.isOpen).toBe(false);

    act(() => {
      result.current.setOpen(true);
    });
    expect(result.current.isOpen).toBe(true);
  });

  it("dispatchSecretsManagerOpen() with no options opens with null tab and focus", () => {
    const { result } = renderHook(() => useSecretsManagerModalState());
    openViaEvent();
    expect(result.current.isOpen).toBe(true);
    expect(result.current.initialTab).toBeNull();
    expect(result.current.focusKey).toBeNull();
    expect(result.current.focusProfileId).toBeNull();
  });

  it("dispatchSecretsManagerOpen() carries tab and focus targets into state", () => {
    const { result } = renderHook(() => useSecretsManagerModalState());
    openViaEvent({
      tab: "secrets",
      focusKey: "provider_key_openai",
      focusProfileId: "prof_1",
    });
    expect(result.current.isOpen).toBe(true);
    expect(result.current.initialTab).toBe("secrets");
    expect(result.current.focusKey).toBe("provider_key_openai");
    expect(result.current.focusProfileId).toBe("prof_1");
  });

  it("a later open without options drops stale focus targets", () => {
    const { result } = renderHook(() => useSecretsManagerModalState());
    openViaEvent({ tab: "secrets", focusKey: "k1", focusProfileId: "p1" });
    openViaEvent();
    expect(result.current.isOpen).toBe(true);
    expect(result.current.initialTab).toBeNull();
    expect(result.current.focusKey).toBeNull();
    expect(result.current.focusProfileId).toBeNull();
  });

  it("close event hides the modal but keeps the last open parameters", () => {
    const { result } = renderHook(() => useSecretsManagerModalState());
    openViaEvent({ tab: "routing", focusKey: "rule_chip" });
    closeViaEvent();
    expect(result.current.isOpen).toBe(false);
    expect(result.current.initialTab).toBe("routing");
    expect(result.current.focusKey).toBe("rule_chip");
  });

  it("toggle event opens a closed modal and adopts the requested tab", () => {
    const { result } = renderHook(() => useSecretsManagerModalState());
    toggleViaEvent("overview");
    expect(result.current.isOpen).toBe(true);
    expect(result.current.initialTab).toBe("overview");

    toggleViaEvent();
    expect(result.current.isOpen).toBe(false);
    expect(result.current.initialTab).toBe("overview");
  });

  it("toggling an already-open modal closes it without adopting a new tab", () => {
    const { result } = renderHook(() => useSecretsManagerModalState());
    openViaEvent({ tab: "logins" });
    toggleViaEvent("routing");
    expect(result.current.isOpen).toBe(false);
    expect(result.current.initialTab).toBe("logins");
  });

  it("openOnTab() opens on the requested tab and clears omitted focus fields", () => {
    const { result } = renderHook(() => useSecretsManagerModalState());
    openViaEvent({ tab: "secrets", focusKey: "stale" });

    act(() => {
      result.current.openOnTab({
        tab: "routing",
        focusProfileId: "prof_2",
      });
    });
    expect(result.current.isOpen).toBe(true);
    expect(result.current.initialTab).toBe("routing");
    expect(result.current.focusKey).toBeNull();
    expect(result.current.focusProfileId).toBe("prof_2");

    act(() => {
      result.current.openOnTab({});
    });
    expect(result.current.isOpen).toBe(true);
    expect(result.current.initialTab).toBeNull();
    expect(result.current.focusProfileId).toBeNull();
  });

  it("clearFocus() clears tab and focus targets while staying open", () => {
    const { result } = renderHook(() => useSecretsManagerModalState());
    openViaEvent({
      tab: "overview",
      focusKey: "k",
      focusProfileId: "p",
    });

    act(() => {
      result.current.clearFocus();
    });
    expect(result.current.isOpen).toBe(true);
    expect(result.current.initialTab).toBeNull();
    expect(result.current.focusKey).toBeNull();
    expect(result.current.focusProfileId).toBeNull();
  });

  it("ignores an event that carries no detail", () => {
    const { result } = renderHook(() => useSecretsManagerModalState());
    act(() => {
      window.dispatchEvent(new Event(TOGGLE_EVENT));
    });
    expect(result.current.isOpen).toBe(false);
    expect(result.current.initialTab).toBeNull();
    expect(result.current.focusKey).toBeNull();
    expect(result.current.focusProfileId).toBeNull();
  });

  it("every mounted instance reacts to one dispatch", () => {
    const modal = renderHook(() => useSecretsManagerModalState());
    const launcher = renderHook(() => useSecretsManagerModalState());

    openViaEvent({ tab: "secrets", focusKey: "k1" });
    expect(modal.result.current.isOpen).toBe(true);
    expect(launcher.result.current.isOpen).toBe(true);
    expect(modal.result.current.initialTab).toBe("secrets");
    expect(launcher.result.current.focusKey).toBe("k1");

    closeViaEvent();
    expect(modal.result.current.isOpen).toBe(false);
    expect(launcher.result.current.isOpen).toBe(false);
  });

  it("keeps every control callback stable across re-renders", () => {
    const { result, rerender } = renderHook(() =>
      useSecretsManagerModalState(),
    );
    const first = result.current;

    rerender();

    expect(result.current.open).toBe(first.open);
    expect(result.current.close).toBe(first.close);
    expect(result.current.toggle).toBe(first.toggle);
    expect(result.current.setOpen).toBe(first.setOpen);
    expect(result.current.openOnTab).toBe(first.openOnTab);
    expect(result.current.clearFocus).toBe(first.clearFocus);
  });

  it("removes its window listener on unmount", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");

    const { unmount } = renderHook(() => useSecretsManagerModalState());
    expect(addSpy).toHaveBeenCalledWith(TOGGLE_EVENT, expect.any(Function));

    unmount();
    expect(removeSpy).toHaveBeenCalledWith(TOGGLE_EVENT, expect.any(Function));
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});

describe("dispatcher window guards", () => {
  it("dispatchers no-op instead of throwing when window is unavailable", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    Reflect.deleteProperty(globalThis, "window");
    try {
      expect(() => {
        dispatchSecretsManagerOpen({ tab: "secrets" });
        dispatchSecretsManagerClose();
        dispatchSecretsManagerToggle("overview");
      }).not.toThrow();
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, "window", descriptor);
      }
    }
  });
});
