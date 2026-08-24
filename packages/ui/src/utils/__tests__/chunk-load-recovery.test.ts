// @vitest-environment jsdom

/**
 * Unit suite for the reload half of chunk load recovery
 * (`tryChunkReloadRecovery` in `src/utils/chunk-load-recovery.ts`), driven
 * through its public API against the real module.
 *
 * The companion suite `chunk-load-recovery-standalone.test.ts` covers
 * `isChunkLoadError` detection in a plain node environment. This file needs a
 * DOM because the reload state machine reads and writes a timestamped
 * sessionStorage marker and navigates: it pins the SSR guard, fresh-session
 * recovery, marker persistence, the cooldown window (inside / boundary /
 * elapsed), corrupt markers, and the private-mode fallbacks where the marker
 * cannot be read (J3) or written (J6).
 *
 * Harness: real module, real jsdom `sessionStorage`; the two private-mode
 * cases swap `window.sessionStorage` for a recording double that fails the
 * way private-mode storage does (method-level vi.spyOn does not intercept
 * jsdom Storage calls, but the whole-property seam behaves identically to the
 * browser's own replacement point). `window.location` is swapped for a
 * recording double (same pattern as `platform/first-run-reset.test.ts`) and
 * the clock is frozen via `test/determinism` so cooldown arithmetic is exact;
 * no navigation ever actually occurs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FROZEN_EPOCH_MS, freezeClock } from "../../../test/determinism";
import { tryChunkReloadRecovery } from "../chunk-load-recovery.ts";

const RELOAD_MARKER_KEY = "eliza:chunk-reload-attempted-at";
const RELOAD_COOLDOWN_MS = 5 * 60 * 1000;

const originalLocationDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "location",
);
const originalSessionStorageDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "sessionStorage",
);

/** Swap `window.location` for a plain object recording reload() invocations. */
function stubLocationReload(): { reloads: () => number } {
  let reloads = 0;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      reload: () => {
        reloads += 1;
      },
      toString: () => "http://localhost/",
    },
  });
  return { reloads: () => reloads };
}

type StorageFailure = "get" | "set" | null;

/**
 * Swap `window.sessionStorage` for a Map-backed Storage double whose read or
 * write side can be made to fail like private-mode storage. Non-failing ops
 * behave like real storage so tests can assert persisted values afterwards.
 */
function installSessionStorage(
  fail: StorageFailure,
  seed?: Record<string, string>,
): { peek: (key: string) => string | null } {
  const map = new Map<string, string>(Object.entries(seed ?? {}));
  const boom = (op: string): never => {
    throw new Error(`sessionStorage ${op} denied`);
  };
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    value: {
      get length(): number {
        return map.size;
      },
      getItem: (key: string): string | null => {
        if (fail === "get") boom("read");
        return map.get(key) ?? null;
      },
      setItem: (key: string, value: string): void => {
        if (fail === "set") boom("write");
        map.set(key, value);
      },
      removeItem: (key: string): void => {
        map.delete(key);
      },
      clear: (): void => {
        map.clear();
      },
      key: (index: number): string | null =>
        Array.from(map.keys())[index] ?? null,
    },
  });
  return {
    peek: (key: string) => map.get(key) ?? null,
  };
}

beforeEach(() => {
  freezeClock(FROZEN_EPOCH_MS);
  window.sessionStorage.clear();
});

afterEach(() => {
  if (originalLocationDescriptor) {
    Object.defineProperty(window, "location", originalLocationDescriptor);
  }
  if (originalSessionStorageDescriptor) {
    Object.defineProperty(
      window,
      "sessionStorage",
      originalSessionStorageDescriptor,
    );
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("chunk-load-recovery", () => {
  describe("tryChunkReloadRecovery", () => {
    it("short-circuits to false with no storage access when window is undefined", () => {
      vi.stubGlobal("window", undefined);
      expect(tryChunkReloadRecovery()).toBe(false);
      vi.unstubAllGlobals();
      expect(window.sessionStorage.getItem(RELOAD_MARKER_KEY)).toBeNull();
    });

    it("recovers a fresh session: initiates one reload and stamps the attempt marker", () => {
      const location = stubLocationReload();
      expect(tryChunkReloadRecovery()).toBe(true);
      expect(location.reloads()).toBe(1);
      expect(window.sessionStorage.getItem(RELOAD_MARKER_KEY)).toBe(
        String(FROZEN_EPOCH_MS),
      );
    });

    it("stays down inside the cooldown window without reloading or rewriting the marker", () => {
      const attemptedAt = FROZEN_EPOCH_MS - 60_000;
      window.sessionStorage.setItem(RELOAD_MARKER_KEY, String(attemptedAt));
      const location = stubLocationReload();

      expect(tryChunkReloadRecovery()).toBe(false);

      expect(location.reloads()).toBe(0);
      // The early return must not touch the persisted marker.
      expect(window.sessionStorage.getItem(RELOAD_MARKER_KEY)).toBe(
        String(attemptedAt),
      );
    });

    it("treats an attempt exactly one cooldown old as eligible again", () => {
      window.sessionStorage.setItem(
        RELOAD_MARKER_KEY,
        String(FROZEN_EPOCH_MS - RELOAD_COOLDOWN_MS),
      );
      const location = stubLocationReload();

      expect(tryChunkReloadRecovery()).toBe(true);
      expect(location.reloads()).toBe(1);
      expect(window.sessionStorage.getItem(RELOAD_MARKER_KEY)).toBe(
        String(FROZEN_EPOCH_MS),
      );
    });

    it("recovers once the stored attempt is older than the cooldown", () => {
      window.sessionStorage.setItem(
        RELOAD_MARKER_KEY,
        String(FROZEN_EPOCH_MS - RELOAD_COOLDOWN_MS - 1),
      );
      const location = stubLocationReload();

      expect(tryChunkReloadRecovery()).toBe(true);
      expect(location.reloads()).toBe(1);
      expect(window.sessionStorage.getItem(RELOAD_MARKER_KEY)).toBe(
        String(FROZEN_EPOCH_MS),
      );
    });

    it("treats an unreadable attempt marker as never-attempted and still recovers (J3)", () => {
      const location = stubLocationReload();
      // Reads fail like private-mode storage; writes land in the double.
      const storage = installSessionStorage("get");

      expect(tryChunkReloadRecovery()).toBe(true);
      expect(location.reloads()).toBe(1);
      // The fresh-attempt marker is still persisted through the write side.
      expect(storage.peek(RELOAD_MARKER_KEY)).toBe(String(FROZEN_EPOCH_MS));
    });

    it("still recovers when the attempt marker cannot be persisted (J6)", () => {
      const location = stubLocationReload();
      installSessionStorage("set");

      expect(tryChunkReloadRecovery()).toBe(true);
      expect(location.reloads()).toBe(1);
    });

    it("does not trust a corrupt marker and recovers anyway", () => {
      window.sessionStorage.setItem(RELOAD_MARKER_KEY, "not-a-timestamp");
      const location = stubLocationReload();

      expect(tryChunkReloadRecovery()).toBe(true);
      expect(location.reloads()).toBe(1);
      // The garbage value is replaced by the current attempt stamp.
      expect(window.sessionStorage.getItem(RELOAD_MARKER_KEY)).toBe(
        String(FROZEN_EPOCH_MS),
      );
    });
  });
});
