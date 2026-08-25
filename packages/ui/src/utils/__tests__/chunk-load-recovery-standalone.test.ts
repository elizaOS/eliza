/**
 * Unit tests for chunk load error detection and reload recovery.
 */
import { describe, expect, it } from "vitest";
import { isChunkLoadError } from "../chunk-load-recovery.ts";

describe("chunk-load-recovery", () => {
  describe("isChunkLoadError", () => {
    it("identifies standard ChunkLoadError by name", () => {
      const err = new Error("Loading chunk 4 failed");
      err.name = "ChunkLoadError";
      expect(isChunkLoadError(err)).toBe(true);
    });

    it("identifies Vite / dynamic import network failure messages", () => {
      expect(
        isChunkLoadError(
          new Error(
            "Failed to fetch dynamically imported module: https://eliza.app/assets/view.js",
          ),
        ),
      ).toBe(true);
      expect(
        isChunkLoadError(new Error("Importing a module script failed.")),
      ).toBe(true);
      expect(
        isChunkLoadError(
          new Error("TypeError: error loading dynamically imported module"),
        ),
      ).toBe(true);
      expect(
        isChunkLoadError(
          new Error(
            "Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of text/html",
          ),
        ),
      ).toBe(true);
    });

    it("returns false for non-chunk errors and non-Error values", () => {
      expect(isChunkLoadError(new Error("Network connection lost"))).toBe(
        false,
      );
      expect(
        isChunkLoadError(new TypeError("Cannot read properties of null")),
      ).toBe(false);
      expect(
        isChunkLoadError("Failed to fetch dynamically imported module"),
      ).toBe(false);
      expect(isChunkLoadError(null)).toBe(false);
      expect(isChunkLoadError(undefined)).toBe(false);
    });
  });
});
