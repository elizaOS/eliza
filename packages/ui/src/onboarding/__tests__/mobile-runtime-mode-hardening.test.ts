// @vitest-environment jsdom

/**
 * Hardening coverage for `../mobile-runtime-mode.ts`. The sibling
 * `../mobile-runtime-mode.test.ts` already covers the happy-path "persist
 * local mode" and "remove on empty target" cases against a native Capacitor
 * shell. This file fills the remaining gaps: pure-function normalization,
 * server-target → mode mapping, the localStorage read path, dispatch of the
 * `MOBILE_RUNTIME_MODE_CHANGED_EVENT`, web-platform fallback (Capacitor
 * reports `web`), unloaded-Capacitor fallback (module import rejects), and
 * idempotence on repeated calls.
 *
 * Gaps intentionally NOT tested because the source file has no observable
 * behavior for them:
 *   - iOS vs Android branching: `mobile-runtime-mode.ts` only checks
 *     `Capacitor.isNativePlatform()` — there is no per-platform branch.
 *     Pre-seed of the on-device agent lives in
 *     `../pre-seed-local-runtime.ts` and is not invoked from this file.
 *   - Deep-link awareness (e.g. `milady://onboard/...`): not referenced in
 *     `mobile-runtime-mode.ts`.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

const { capacitorState, preferencesRemoveMock, preferencesSetMock } =
  vi.hoisted(() => ({
    capacitorState: { isNative: true },
    preferencesRemoveMock: vi.fn(async () => undefined),
    preferencesSetMock: vi.fn(async () => undefined),
  }));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => capacitorState.isNative,
  },
}));

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    remove: preferencesRemoveMock,
    set: preferencesSetMock,
  },
}));

import {
  MOBILE_RUNTIME_MODE_STORAGE_KEY,
  mobileRuntimeModeForServerTarget,
  normalizeMobileRuntimeMode,
  persistMobileRuntimeModeForServerTarget,
  readPersistedMobileRuntimeMode,
} from "../mobile-runtime-mode";
import { MOBILE_RUNTIME_MODE_CHANGED_EVENT } from "../../events";

async function flushNativeWrites(): Promise<void> {
  // Persist fires a fire-and-forget native write that awaits
  // `Promise.all([import("@capacitor/core"), import("@capacitor/preferences")])`
  // then `Preferences.set/.remove`. Dynamic imports resolve a few microtasks
  // later than a bare `Promise.resolve()`, so we yield through a macrotask
  // boundary plus a generous microtask drain to make sure pending native
  // writes are observable (and therefore can be cleared) before the next test.
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

afterEach(async () => {
  await flushNativeWrites();
  window.localStorage.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  capacitorState.isNative = true;
});

describe("normalizeMobileRuntimeMode", () => {
  it.each(["remote-mac", "cloud", "cloud-hybrid", "local"] as const)(
    "passes %s through unchanged",
    (mode) => {
      expect(normalizeMobileRuntimeMode(mode)).toBe(mode);
    },
  );

  it("trims surrounding whitespace before matching", () => {
    expect(normalizeMobileRuntimeMode("  local  ")).toBe("local");
    expect(normalizeMobileRuntimeMode("\tcloud\n")).toBe("cloud");
  });

  it("returns null for null, undefined, and empty input", () => {
    expect(normalizeMobileRuntimeMode(null)).toBeNull();
    expect(normalizeMobileRuntimeMode(undefined)).toBeNull();
    expect(normalizeMobileRuntimeMode("")).toBeNull();
    expect(normalizeMobileRuntimeMode("   ")).toBeNull();
  });

  it("returns null for unknown modes (no fuzzy match)", () => {
    expect(normalizeMobileRuntimeMode("LOCAL")).toBeNull();
    expect(normalizeMobileRuntimeMode("locale")).toBeNull();
    expect(normalizeMobileRuntimeMode("remote")).toBeNull();
    expect(normalizeMobileRuntimeMode("elizacloud")).toBeNull();
    expect(normalizeMobileRuntimeMode("{}")).toBeNull();
  });
});

describe("mobileRuntimeModeForServerTarget", () => {
  it("maps every onboarding server target to its mobile mode", () => {
    expect(mobileRuntimeModeForServerTarget("remote")).toBe("remote-mac");
    expect(mobileRuntimeModeForServerTarget("elizacloud")).toBe("cloud");
    expect(mobileRuntimeModeForServerTarget("elizacloud-hybrid")).toBe(
      "cloud-hybrid",
    );
    expect(mobileRuntimeModeForServerTarget("local")).toBe("local");
  });

  it("returns null for the empty-string target (no selection)", () => {
    expect(mobileRuntimeModeForServerTarget("")).toBeNull();
  });
});

describe("readPersistedMobileRuntimeMode", () => {
  it("returns null when no value has been persisted", () => {
    expect(readPersistedMobileRuntimeMode()).toBeNull();
  });

  it.each(["remote-mac", "cloud", "cloud-hybrid", "local"] as const)(
    "round-trips %s through localStorage",
    (mode) => {
      window.localStorage.setItem(MOBILE_RUNTIME_MODE_STORAGE_KEY, mode);
      expect(readPersistedMobileRuntimeMode()).toBe(mode);
    },
  );

  it("ignores garbage values written by an older build", () => {
    window.localStorage.setItem(
      MOBILE_RUNTIME_MODE_STORAGE_KEY,
      "legacy-value",
    );
    expect(readPersistedMobileRuntimeMode()).toBeNull();
  });

  it("returns null when localStorage.getItem throws (embedded shell)", () => {
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("storage unavailable");
      });
    try {
      expect(readPersistedMobileRuntimeMode()).toBeNull();
    } finally {
      getItem.mockRestore();
    }
  });
});

describe("persistMobileRuntimeModeForServerTarget", () => {
  it.each([
    ["remote", "remote-mac"],
    ["elizacloud", "cloud"],
    ["elizacloud-hybrid", "cloud-hybrid"],
    ["local", "local"],
  ] as const)(
    "writes %s as %s to localStorage and Capacitor Preferences",
    async (target, expected) => {
      persistMobileRuntimeModeForServerTarget(target);

      expect(window.localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBe(
        expected,
      );
      await vi.waitFor(() => {
        expect(preferencesSetMock).toHaveBeenCalledWith({
          key: MOBILE_RUNTIME_MODE_STORAGE_KEY,
          value: expected,
        });
      });
      expect(preferencesRemoveMock).not.toHaveBeenCalled();
    },
  );

  it("clears a prior selection from localStorage when called with an empty target", async () => {
    window.localStorage.setItem(MOBILE_RUNTIME_MODE_STORAGE_KEY, "local");

    persistMobileRuntimeModeForServerTarget("");

    expect(window.localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBe(
      null,
    );
    await vi.waitFor(() => {
      expect(preferencesRemoveMock).toHaveBeenCalledWith({
        key: MOBILE_RUNTIME_MODE_STORAGE_KEY,
      });
    });
    expect(preferencesSetMock).not.toHaveBeenCalled();
  });

  it("dispatches MOBILE_RUNTIME_MODE_CHANGED_EVENT with the resolved mode", () => {
    const listener = vi.fn();
    document.addEventListener(
      MOBILE_RUNTIME_MODE_CHANGED_EVENT,
      listener as EventListener,
    );
    try {
      persistMobileRuntimeModeForServerTarget("local");

      expect(listener).toHaveBeenCalledTimes(1);
      const event = listener.mock.calls[0][0] as CustomEvent<{
        mode: string | null;
      }>;
      expect(event.type).toBe(MOBILE_RUNTIME_MODE_CHANGED_EVENT);
      expect(event.detail).toEqual({ mode: "local" });
    } finally {
      document.removeEventListener(
        MOBILE_RUNTIME_MODE_CHANGED_EVENT,
        listener as EventListener,
      );
    }
  });

  it("dispatches the change event with mode=null when clearing the selection", () => {
    const listener = vi.fn();
    document.addEventListener(
      MOBILE_RUNTIME_MODE_CHANGED_EVENT,
      listener as EventListener,
    );
    try {
      persistMobileRuntimeModeForServerTarget("");

      expect(listener).toHaveBeenCalledTimes(1);
      const event = listener.mock.calls[0][0] as CustomEvent<{
        mode: string | null;
      }>;
      expect(event.detail).toEqual({ mode: null });
    } finally {
      document.removeEventListener(
        MOBILE_RUNTIME_MODE_CHANGED_EVENT,
        listener as EventListener,
      );
    }
  });

  it("skips Capacitor Preferences when running on the web platform", async () => {
    capacitorState.isNative = false;

    persistMobileRuntimeModeForServerTarget("elizacloud");

    // Allow the queued async path to settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(window.localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBe(
      "cloud",
    );
    expect(preferencesSetMock).not.toHaveBeenCalled();
    expect(preferencesRemoveMock).not.toHaveBeenCalled();
  });

  it("does not throw when Capacitor Preferences.set rejects", async () => {
    preferencesSetMock.mockRejectedValueOnce(new Error("native bridge down"));

    expect(() =>
      persistMobileRuntimeModeForServerTarget("local"),
    ).not.toThrow();

    // The web-side write must still land even if the native write fails.
    expect(window.localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBe(
      "local",
    );
    await vi.waitFor(() => {
      expect(preferencesSetMock).toHaveBeenCalledTimes(1);
    });
  });

  it("does not throw when Capacitor Preferences.remove rejects", async () => {
    preferencesRemoveMock.mockRejectedValueOnce(new Error("native bridge down"));

    expect(() => persistMobileRuntimeModeForServerTarget("")).not.toThrow();

    await vi.waitFor(() => {
      expect(preferencesRemoveMock).toHaveBeenCalledTimes(1);
    });
  });

  it("does not throw when localStorage.setItem throws", () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota exceeded");
      });
    try {
      expect(() =>
        persistMobileRuntimeModeForServerTarget("local"),
      ).not.toThrow();
    } finally {
      setItem.mockRestore();
    }
  });

  it("does not throw when localStorage.removeItem throws", () => {
    const removeItem = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(() => {
        throw new Error("storage locked");
      });
    try {
      expect(() => persistMobileRuntimeModeForServerTarget("")).not.toThrow();
    } finally {
      removeItem.mockRestore();
    }
  });

  it("is idempotent across repeated invocations with the same target", async () => {
    persistMobileRuntimeModeForServerTarget("local");
    await vi.waitFor(() => {
      expect(preferencesSetMock).toHaveBeenCalledTimes(1);
    });
    persistMobileRuntimeModeForServerTarget("local");
    await vi.waitFor(() => {
      expect(preferencesSetMock).toHaveBeenCalledTimes(2);
    });
    persistMobileRuntimeModeForServerTarget("local");
    await vi.waitFor(() => {
      expect(preferencesSetMock).toHaveBeenCalledTimes(3);
    });
    // localStorage converges on a single value regardless of repeat count.
    expect(window.localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBe(
      "local",
    );
    // Each call emits exactly one Preferences.set with the same payload —
    // no spurious removes mixed in.
    expect(preferencesRemoveMock).not.toHaveBeenCalled();
    for (const call of (preferencesSetMock as Mock).mock.calls) {
      expect(call[0]).toEqual({
        key: MOBILE_RUNTIME_MODE_STORAGE_KEY,
        value: "local",
      });
    }
  });

  it("switches the persisted mode in place when the target changes", async () => {
    persistMobileRuntimeModeForServerTarget("local");
    await vi.waitFor(() => {
      expect(preferencesSetMock).toHaveBeenCalledTimes(1);
    });
    persistMobileRuntimeModeForServerTarget("elizacloud");
    await vi.waitFor(() => {
      expect(preferencesSetMock).toHaveBeenCalledTimes(2);
    });

    expect(window.localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBe(
      "cloud",
    );
    expect(preferencesSetMock.mock.calls[0][0]).toEqual({
      key: MOBILE_RUNTIME_MODE_STORAGE_KEY,
      value: "local",
    });
    expect(preferencesSetMock.mock.calls[1][0]).toEqual({
      key: MOBILE_RUNTIME_MODE_STORAGE_KEY,
      value: "cloud",
    });
  });
});

describe("readPersistedMobileRuntimeMode round-trips persist output", () => {
  it("writing local via persist is observable via read", async () => {
    persistMobileRuntimeModeForServerTarget("local");
    expect(readPersistedMobileRuntimeMode()).toBe("local");
    await vi.waitFor(() => {
      expect(preferencesSetMock).toHaveBeenCalled();
    });
  });

  it("clearing the target makes read return null", async () => {
    persistMobileRuntimeModeForServerTarget("elizacloud");
    expect(readPersistedMobileRuntimeMode()).toBe("cloud");
    await vi.waitFor(() => {
      expect(preferencesSetMock).toHaveBeenCalledTimes(1);
    });
    persistMobileRuntimeModeForServerTarget("");
    expect(readPersistedMobileRuntimeMode()).toBeNull();
    await vi.waitFor(() => {
      expect(preferencesRemoveMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe("MobileRuntimeMode constants are stable", () => {
  it("storage key matches the literal contract used by AOSP pre-seed", () => {
    // pre-seed-local-runtime.ts assumes this key shape — guard against drift.
    expect(MOBILE_RUNTIME_MODE_STORAGE_KEY).toBe("eliza:mobile-runtime-mode");
  });
});
