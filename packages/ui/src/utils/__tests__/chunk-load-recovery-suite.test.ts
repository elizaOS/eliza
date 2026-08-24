/**
 * Unit tests for chunk-load recovery and error classification.
 * Validates dynamic import failure detection, sessionStorage cooldown, and reload triggers.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isChunkLoadError,
  tryChunkReloadRecovery,
} from "../chunk-load-recovery.ts";

describe("chunk-load-recovery", () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      configurable: true,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  describe("isChunkLoadError", () => {
    it("identifies ChunkLoadError by name", () => {
      const err = new Error("Loading chunk 42 failed");
      err.name = "ChunkLoadError";
      expect(isChunkLoadError(err)).toBe(true);
    });

    it("identifies known lazy-import error messages", () => {
      expect(
        isChunkLoadError(
          new Error(
            "TypeError: Failed to fetch dynamically imported module: /assets/view.js",
          ),
        ),
      ).toBe(true);
      expect(
        isChunkLoadError(new Error("Importing a module script failed.")),
      ).toBe(true);
      expect(
        isChunkLoadError(
          new Error("error loading dynamically imported module /app.js"),
        ),
      ).toBe(true);
      expect(
        isChunkLoadError(
          new Error(
            "Failed to load: Expected a JavaScript-or-Wasm module script but got 404",
          ),
        ),
      ).toBe(true);
    });

    it("returns false for unrelated errors and primitives", () => {
      expect(isChunkLoadError(new Error("Network connection lost"))).toBe(
        false,
      );
      expect(
        isChunkLoadError("Failed to fetch dynamically imported module"),
      ).toBe(false);
      expect(isChunkLoadError(null)).toBe(false);
      expect(isChunkLoadError(undefined)).toBe(false);
    });
  });

  describe("tryChunkReloadRecovery", () => {
    it("returns false when window is undefined", () => {
      Object.defineProperty(globalThis, "window", {
        value: undefined,
        configurable: true,
        writable: true,
      });
      expect(tryChunkReloadRecovery()).toBe(false);
    });

    it("triggers reload and stores timestamp when not in cooldown", () => {
      const storage: Record<string, string> = {};
      const mockReload = vi.fn();

      Object.defineProperty(globalThis, "window", {
        value: {
          sessionStorage: {
            getItem: (k: string) => storage[k] ?? null,
            setItem: (k: string, v: string) => {
              storage[k] = v;
            },
          },
          location: { reload: mockReload },
        },
        configurable: true,
        writable: true,
      });

      const recovered = tryChunkReloadRecovery();
      expect(recovered).toBe(true);
      expect(mockReload).toHaveBeenCalled();
      expect(storage["eliza:chunk-reload-attempted-at"]).toBeDefined();
    });

    it("suppresses reload within 5-minute cooldown window", () => {
      const now = Date.now();
      const storage: Record<string, string> = {
        "eliza:chunk-reload-attempted-at": String(now - 60_000), // 1 minute ago
      };
      const mockReload = vi.fn();

      Object.defineProperty(globalThis, "window", {
        value: {
          sessionStorage: {
            getItem: (k: string) => storage[k] ?? null,
            setItem: (k: string, v: string) => {
              storage[k] = v;
            },
          },
          location: { reload: mockReload },
        },
        configurable: true,
        writable: true,
      });

      const recovered = tryChunkReloadRecovery();
      expect(recovered).toBe(false);
      expect(mockReload).not.toHaveBeenCalled();
    });
  });
});
