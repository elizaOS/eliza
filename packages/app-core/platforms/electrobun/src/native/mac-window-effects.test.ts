/** Exercises mac-window-effects fallbacks, string ownership, and fn-monitor mapping with deterministic app-core test fixtures. */

import type { Pointer } from "bun:ffi";
import { assertDlopenPathAllowed } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveNativeLibraryCandidate } from "../../../../src/platform/native-library-policy";

const WINDOW = 7 as Pointer;
const NATIVE_PTR = 99 as Pointer;

const ffi = vi.hoisted(() => {
  const dylibPathDefault = "/tmp/libMacWindowEffects.dylib";
  const symbols = {
    enableWindowVibrancy: vi.fn<(ptr: Pointer) => boolean>(),
    setWindowShadowEnabled:
      vi.fn<(ptr: Pointer, enabled: boolean) => boolean>(),
    setWindowTrafficLightsPosition:
      vi.fn<(ptr: Pointer, x: number, y: number) => boolean>(),
    setNativeWindowDragRegion:
      vi.fn<(ptr: Pointer, x: number, height: number) => boolean>(),
    disableWindowBackForwardNavigationGestures:
      vi.fn<(ptr: Pointer) => boolean>(),
    orderOutWindow: vi.fn<(ptr: Pointer) => boolean>(),
    makeKeyAndOrderFrontWindow: vi.fn<(ptr: Pointer) => boolean>(),
    isAppActive: vi.fn<() => boolean>(),
    isWindowKey: vi.fn<(ptr: Pointer) => boolean>(),
    createSecurityScopedBookmark: vi.fn<(path: Pointer) => Pointer | null>(),
    startAccessingSecurityScopedBookmark:
      vi.fn<(bookmark: Pointer) => Pointer | null>(),
    stopAccessingSecurityScopedBookmarks: vi.fn<() => void>(),
    freeNativeCString: vi.fn<(value: Pointer) => void>(),
    elizaOnboardingNotificationPost:
      vi.fn<(title: Pointer, body: Pointer) => boolean>(),
    elizaOnboardingGetChoice: vi.fn<() => number>(),
    elizaOnboardingNotificationDismiss: vi.fn<() => void>(),
    checkNotificationPermission: vi.fn<() => number>(),
    requestNotificationPermission: vi.fn<() => number>(),
    elizaFnMonitorStart: vi.fn<() => number>(),
    elizaFnMonitorStop: vi.fn<() => void>(),
    elizaFnMonitorPoll: vi.fn<() => number>(),
    elizaFnMonitorIsHealthy: vi.fn<() => boolean>(),
    elizaFnMonitorIsFnDown: vi.fn<() => boolean>(),
    elizaFnSystemUsageType: vi.fn<() => number>(),
  };
  return {
    dylibPathDefault,
    dylibPath: dylibPathDefault as string | null,
    nativeString: "scoped-bookmark",
    symbols,
    ptr: vi.fn((_view: ArrayBufferView) => 51 as Pointer),
    dlopen: vi.fn(() => ({ symbols, close: vi.fn() })),
  };
});

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return {
    ...actual,
    join: (...segments: string[]) =>
      actual.join(
        ...segments.map((segment) =>
          typeof segment === "string" ? segment : "/virtual-electrobun-native",
        ),
      ),
  };
});

vi.mock("bun:ffi", () => {
  class CString {
    constructor(private readonly value: Pointer) {}
    toString(): string {
      void this.value;
      return ffi.nativeString;
    }
  }
  return {
    FFIType: { ptr: 0, bool: 1, f64: 2, i32: 3, cstring: 4, void: 5 },
    CString,
    ptr: ffi.ptr,
    dlopen: ffi.dlopen,
  };
});

vi.mock("../../../../src/platform/native-library-policy", () => ({
  resolveNativeLibraryCandidate: vi.fn(() => ffi.dylibPath),
}));

vi.mock("@elizaos/core", () => ({
  assertDlopenPathAllowed: vi.fn(),
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

async function loadEffects() {
  vi.resetModules();
  return import("./mac-window-effects");
}

function encodedCString(callIndex = 0): string {
  const view = ffi.ptr.mock.calls[callIndex]?.[0];
  if (!view) {
    throw new Error(`ptr was not called at index ${callIndex}`);
  }
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  expect(bytes[bytes.byteLength - 1]).toBe(0);
  return Buffer.from(bytes.subarray(0, bytes.byteLength - 1)).toString("utf8");
}

beforeEach(() => {
  ffi.dylibPath = ffi.dylibPathDefault;
  ffi.nativeString = "scoped-bookmark";
  ffi.ptr.mockReset();
  ffi.ptr.mockReturnValue(51 as Pointer);
  ffi.dlopen.mockReset();
  ffi.dlopen.mockImplementation(() => ({
    symbols: ffi.symbols,
    close: vi.fn(),
  }));
  for (const fn of Object.values(ffi.symbols)) {
    fn.mockReset();
  }
  vi.mocked(resolveNativeLibraryCandidate).mockClear();
  vi.mocked(assertDlopenPathAllowed).mockClear();
});

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

describe("mac-window-effects unavailable fallbacks", () => {
  it.each(["linux", "win32"] as const)(
    "returns JS fallbacks on %s without opening the dylib",
    async (platform) => {
      stubPlatform(platform);
      const effects = await loadEffects();

      expect(effects.enableVibrancy(WINDOW)).toBe(false);
      expect(effects.setWindowShadow(WINDOW, true)).toBe(false);
      expect(effects.setTrafficLightsPosition(WINDOW, 12, 8)).toBe(false);
      expect(effects.setNativeDragRegion(WINDOW, 0, 0)).toBe(false);
      expect(effects.disableBackForwardNavigationGestures(WINDOW)).toBe(false);
      expect(effects.orderOut(WINDOW)).toBe(false);
      expect(effects.makeKeyAndOrderFront(WINDOW)).toBe(false);
      expect(effects.isAppActive()).toBe(false);
      expect(effects.isKeyWindow(WINDOW)).toBe(false);
      expect(effects.createSecurityScopedBookmark("/tmp/x")).toBeNull();
      expect(effects.startAccessingSecurityScopedBookmark("bm")).toBeNull();
      expect(effects.stopAccessingSecurityScopedBookmarks()).toBeUndefined();
      expect(effects.postOnboardingNotification("t", "b")).toBe(false);
      expect(effects.getOnboardingChoice()).toBe(0);
      expect(effects.dismissOnboardingNotification()).toBeUndefined();
      expect(effects.checkNotificationPermission()).toBeNull();
      expect(effects.requestNotificationPermission()).toBeNull();
      expect(effects.startFnMonitor()).toBe("unavailable");
      expect(effects.stopFnMonitor()).toBeUndefined();
      expect(effects.pollFnMonitor()).toBeNull();
      expect(effects.isFnMonitorHealthy()).toBe(false);
      expect(effects.isFnKeyDown()).toBe(false);
      expect(effects.getFnSystemUsageType()).toBe(-1);
      expect(ffi.dlopen).not.toHaveBeenCalled();
      expect(resolveNativeLibraryCandidate).not.toHaveBeenCalled();
    },
  );

  it("treats a missing dylib as unavailable and warns with the build hint", async () => {
    stubPlatform("darwin");
    ffi.dylibPath = null;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const effects = await loadEffects();

    expect(effects.startFnMonitor()).toBe("unavailable");
    expect(effects.getFnSystemUsageType()).toBe(-1);
    expect(effects.checkNotificationPermission()).toBeNull();
    expect(ffi.dlopen).not.toHaveBeenCalled();
    expect(assertDlopenPathAllowed).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Dylib not found at"),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("bun run build:native-effects"),
    );
    warn.mockRestore();
  });

  it("treats a dlopen failure as unavailable without throwing", async () => {
    stubPlatform("darwin");
    ffi.dlopen.mockImplementation(() => {
      throw new Error("mach-o load failed");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const effects = await loadEffects();

    expect(effects.enableVibrancy(WINDOW)).toBe(false);
    expect(effects.startFnMonitor()).toBe("unavailable");
    expect(effects.pollFnMonitor()).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "[MacEffects] Failed to load dylib:",
      expect.any(Error),
    );
    warn.mockRestore();
  });
});

describe("mac-window-effects loaded native mapping", () => {
  async function loadDarwin() {
    stubPlatform("darwin");
    return loadEffects();
  }

  it("loads the resolved dylib once and reuses the handle", async () => {
    const effects = await loadDarwin();
    ffi.symbols.enableWindowVibrancy.mockReturnValue(true);

    expect(effects.enableVibrancy(WINDOW)).toBe(true);
    expect(effects.enableVibrancy(WINDOW)).toBe(true);
    expect(ffi.dlopen).toHaveBeenCalledTimes(1);
    expect(ffi.dlopen).toHaveBeenCalledWith(
      ffi.dylibPathDefault,
      expect.objectContaining({
        enableWindowVibrancy: expect.any(Object),
        elizaCalendarStoreChangesStart: expect.any(Object),
        elizaCalendarStoreChangesPoll: expect.any(Object),
        elizaCalendarStoreChangesStop: expect.any(Object),
        elizaFnMonitorPoll: expect.any(Object),
      }),
    );
    expect(assertDlopenPathAllowed).toHaveBeenCalledWith(ffi.dylibPathDefault);
    expect(resolveNativeLibraryCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "bundled Mac window effects library",
        path: expect.stringContaining("libMacWindowEffects.dylib"),
      }),
      expect.objectContaining({
        expectedBasename: "libMacWindowEffects.dylib",
      }),
    );
  });

  it("forwards window-effect arguments to the native symbols", async () => {
    const effects = await loadDarwin();
    ffi.symbols.enableWindowVibrancy.mockReturnValue(true);
    ffi.symbols.setWindowShadowEnabled.mockReturnValue(true);
    ffi.symbols.setWindowTrafficLightsPosition.mockReturnValue(false);
    ffi.symbols.setNativeWindowDragRegion.mockReturnValue(true);
    ffi.symbols.disableWindowBackForwardNavigationGestures.mockReturnValue(
      true,
    );
    ffi.symbols.orderOutWindow.mockReturnValue(true);
    ffi.symbols.makeKeyAndOrderFrontWindow.mockReturnValue(true);
    ffi.symbols.isAppActive.mockReturnValue(true);
    ffi.symbols.isWindowKey.mockReturnValue(false);

    expect(effects.enableVibrancy(WINDOW)).toBe(true);
    expect(effects.setWindowShadow(WINDOW, false)).toBe(true);
    expect(effects.setTrafficLightsPosition(WINDOW, 16, 9)).toBe(false);
    expect(effects.setNativeDragRegion(WINDOW, 4, 0)).toBe(true);
    expect(effects.disableBackForwardNavigationGestures(WINDOW)).toBe(true);
    expect(effects.orderOut(WINDOW)).toBe(true);
    expect(effects.makeKeyAndOrderFront(WINDOW)).toBe(true);
    expect(effects.isAppActive()).toBe(true);
    expect(effects.isKeyWindow(WINDOW)).toBe(false);

    expect(ffi.symbols.enableWindowVibrancy).toHaveBeenCalledWith(WINDOW);
    expect(ffi.symbols.setWindowShadowEnabled).toHaveBeenCalledWith(
      WINDOW,
      false,
    );
    expect(ffi.symbols.setWindowTrafficLightsPosition).toHaveBeenCalledWith(
      WINDOW,
      16,
      9,
    );
    expect(ffi.symbols.setNativeWindowDragRegion).toHaveBeenCalledWith(
      WINDOW,
      4,
      0,
    );
    expect(
      ffi.symbols.disableWindowBackForwardNavigationGestures,
    ).toHaveBeenCalledWith(WINDOW);
    expect(ffi.symbols.orderOutWindow).toHaveBeenCalledWith(WINDOW);
    expect(ffi.symbols.makeKeyAndOrderFrontWindow).toHaveBeenCalledWith(WINDOW);
    expect(ffi.symbols.isWindowKey).toHaveBeenCalledWith(WINDOW);
  });

  it("rejects empty and whitespace-only bookmark paths without calling native", async () => {
    const effects = await loadDarwin();

    expect(effects.createSecurityScopedBookmark("")).toBeNull();
    expect(effects.createSecurityScopedBookmark("   ")).toBeNull();
    expect(effects.createSecurityScopedBookmark("\n\t")).toBeNull();
    expect(effects.startAccessingSecurityScopedBookmark("")).toBeNull();
    expect(effects.startAccessingSecurityScopedBookmark("  ")).toBeNull();
    expect(ffi.symbols.createSecurityScopedBookmark).not.toHaveBeenCalled();
    expect(
      ffi.symbols.startAccessingSecurityScopedBookmark,
    ).not.toHaveBeenCalled();
    expect(ffi.ptr).not.toHaveBeenCalled();
  });

  it("passes the untrimmed path through a NUL-terminated buffer", async () => {
    const effects = await loadDarwin();
    ffi.symbols.createSecurityScopedBookmark.mockReturnValue(null);

    expect(effects.createSecurityScopedBookmark(" /tmp/scoped ")).toBeNull();
    expect(encodedCString(0)).toBe(" /tmp/scoped ");
    expect(ffi.symbols.createSecurityScopedBookmark).toHaveBeenCalledWith(
      51 as Pointer,
    );
    expect(ffi.symbols.freeNativeCString).not.toHaveBeenCalled();
  });

  it("decodes a native bookmark string and always frees the C string", async () => {
    const effects = await loadDarwin();
    ffi.nativeString = "decoded-bookmark";
    ffi.symbols.createSecurityScopedBookmark.mockReturnValue(NATIVE_PTR);
    ffi.symbols.startAccessingSecurityScopedBookmark.mockReturnValue(
      NATIVE_PTR,
    );

    expect(effects.createSecurityScopedBookmark("/tmp/a")).toBe(
      "decoded-bookmark",
    );
    expect(effects.startAccessingSecurityScopedBookmark("raw")).toBe(
      "decoded-bookmark",
    );
    expect(ffi.symbols.freeNativeCString).toHaveBeenCalledTimes(2);
    expect(ffi.symbols.freeNativeCString).toHaveBeenNthCalledWith(
      1,
      NATIVE_PTR,
    );
    expect(ffi.symbols.freeNativeCString).toHaveBeenNthCalledWith(
      2,
      NATIVE_PTR,
    );
  });

  it("posts onboarding copy and maps choice codes 0-4", async () => {
    const effects = await loadDarwin();
    ffi.symbols.elizaOnboardingNotificationPost.mockReturnValue(true);
    ffi.symbols.elizaOnboardingGetChoice.mockReturnValue(0);

    expect(effects.postOnboardingNotification("Title", "Body")).toBe(true);
    expect(encodedCString(0)).toBe("Title");
    expect(encodedCString(1)).toBe("Body");
    expect(effects.getOnboardingChoice()).toBe(0);

    ffi.symbols.elizaOnboardingGetChoice.mockReturnValue(1);
    expect(effects.getOnboardingChoice()).toBe(1);
    ffi.symbols.elizaOnboardingGetChoice.mockReturnValue(2);
    expect(effects.getOnboardingChoice()).toBe(2);
    ffi.symbols.elizaOnboardingGetChoice.mockReturnValue(3);
    expect(effects.getOnboardingChoice()).toBe(3);
    ffi.symbols.elizaOnboardingGetChoice.mockReturnValue(4);
    expect(effects.getOnboardingChoice()).toBe(4);

    effects.dismissOnboardingNotification();
    expect(
      ffi.symbols.elizaOnboardingNotificationDismiss,
    ).toHaveBeenCalledTimes(1);
  });

  it("returns 0 from a loaded permission probe instead of collapsing it to null", async () => {
    const effects = await loadDarwin();
    ffi.symbols.checkNotificationPermission.mockReturnValue(0);
    ffi.symbols.requestNotificationPermission.mockReturnValue(1);

    expect(effects.checkNotificationPermission()).toBe(0);
    expect(effects.requestNotificationPermission()).toBe(1);
  });

  it("maps fn-monitor start codes, including permission-missing and failed", async () => {
    const effects = await loadDarwin();

    ffi.symbols.elizaFnMonitorStart.mockReturnValue(0);
    expect(effects.startFnMonitor()).toBe("started");
    ffi.symbols.elizaFnMonitorStart.mockReturnValue(1);
    expect(effects.startFnMonitor()).toBe("permission-missing");
    ffi.symbols.elizaFnMonitorStart.mockReturnValue(2);
    expect(effects.startFnMonitor()).toBe("failed");
    ffi.symbols.elizaFnMonitorStart.mockReturnValue(-1);
    expect(effects.startFnMonitor()).toBe("failed");

    effects.stopFnMonitor();
    expect(ffi.symbols.elizaFnMonitorStop).toHaveBeenCalledTimes(1);
  });

  it("drains fn-monitor events and treats 0 / unknown as an empty queue", async () => {
    const effects = await loadDarwin();

    ffi.symbols.elizaFnMonitorPoll.mockReturnValue(0);
    expect(effects.pollFnMonitor()).toBeNull();
    ffi.symbols.elizaFnMonitorPoll.mockReturnValue(1);
    expect(effects.pollFnMonitor()).toBe("down");
    ffi.symbols.elizaFnMonitorPoll.mockReturnValue(2);
    expect(effects.pollFnMonitor()).toBe("up");
    ffi.symbols.elizaFnMonitorPoll.mockReturnValue(3);
    expect(effects.pollFnMonitor()).toBe("up-chord");
    ffi.symbols.elizaFnMonitorPoll.mockReturnValue(99);
    expect(effects.pollFnMonitor()).toBeNull();
  });

  it("reports tap health and physical fn state from the native monitor", async () => {
    const effects = await loadDarwin();
    ffi.symbols.elizaFnMonitorIsHealthy.mockReturnValue(true);
    ffi.symbols.elizaFnMonitorIsFnDown.mockReturnValue(true);
    expect(effects.isFnMonitorHealthy()).toBe(true);
    expect(effects.isFnKeyDown()).toBe(true);

    ffi.symbols.elizaFnMonitorIsHealthy.mockReturnValue(false);
    ffi.symbols.elizaFnMonitorIsFnDown.mockReturnValue(false);
    expect(effects.isFnMonitorHealthy()).toBe(false);
    expect(effects.isFnKeyDown()).toBe(false);
  });

  it("maps AppleFnUsageType -1 to the macOS emoji default of 2", async () => {
    const effects = await loadDarwin();

    ffi.symbols.elizaFnSystemUsageType.mockReturnValue(-1);
    expect(effects.getFnSystemUsageType()).toBe(2);
    ffi.symbols.elizaFnSystemUsageType.mockReturnValue(0);
    expect(effects.getFnSystemUsageType()).toBe(0);
    ffi.symbols.elizaFnSystemUsageType.mockReturnValue(1);
    expect(effects.getFnSystemUsageType()).toBe(1);
    ffi.symbols.elizaFnSystemUsageType.mockReturnValue(2);
    expect(effects.getFnSystemUsageType()).toBe(2);
    ffi.symbols.elizaFnSystemUsageType.mockReturnValue(3);
    expect(effects.getFnSystemUsageType()).toBe(3);
  });
});
