import { describe, expect, it } from "vitest";
import { farcasterPlugin } from "../index";

describe("Farcaster Plugin", () => {
  describe("Plugin Structure", () => {
    it("should export a valid plugin", () => {
      expect(farcasterPlugin).toBeDefined();
      expect(farcasterPlugin.name).toBe("farcaster");
    });

    it("should have a description", () => {
      expect(farcasterPlugin.description).toBeDefined();
      expect(typeof farcasterPlugin.description).toBe("string");
    });

    it("should have services", () => {
      expect(farcasterPlugin.services).toBeDefined();
      expect(Array.isArray(farcasterPlugin.services)).toBe(true);
    });

    it("should have actions", () => {
      expect(farcasterPlugin.actions).toBeDefined();
      expect(Array.isArray(farcasterPlugin.actions)).toBe(true);
    });
  });
});
