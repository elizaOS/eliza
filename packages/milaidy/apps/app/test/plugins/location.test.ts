/**
 * Tests for @milaidy/capacitor-location plugin
 *
 * Verifies:
 * - Module exports (LocationWeb class + definition types)
 * - LocationWeb class instantiation and method signatures
 * - Watch management (clearWatch cleans up)
 * - All plugin interface methods are present
 */
import { describe, it, expect, beforeEach } from "vitest";
import { LocationWeb } from "../../plugins/location/src/web";

describe("@milaidy/capacitor-location", () => {
  let location: LocationWeb;

  beforeEach(() => {
    location = new LocationWeb();
  });

  describe("module exports", () => {
    it("exports LocationWeb class", () => {
      expect(LocationWeb).toBeDefined();
      expect(typeof LocationWeb).toBe("function");
    });

    it("creates an instance with all expected methods", () => {
      expect(typeof location.getCurrentPosition).toBe("function");
      expect(typeof location.watchPosition).toBe("function");
      expect(typeof location.clearWatch).toBe("function");
      expect(typeof location.checkPermissions).toBe("function");
      expect(typeof location.requestPermissions).toBe("function");
    });
  });

  describe("watch management", () => {
    it("clearWatch handles unknown watchId gracefully", async () => {
      // Should not throw even with an unknown watch ID
      await expect(
        location.clearWatch({ watchId: "nonexistent-watch-id" })
      ).resolves.toBeUndefined();
    });
  });

  describe("definition types", () => {
    it("definitions module loads without error", async () => {
      const mod = await import("../../plugins/location/src/definitions");
      expect(mod).toBeDefined();
    });
  });
});
