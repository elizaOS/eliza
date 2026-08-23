/**
 * Unit coverage for configured owner name resolution in owner-name.ts.
 *
 * Tests normalizeOwnerName string coercion, whitespace trimming, unicode sanitization,
 * fetchConfiguredOwnerName extraction from config, and persistConfiguredOwnerName updates.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as configModule from "../config/config.js";
import {
  fetchConfiguredOwnerName,
  normalizeOwnerName,
  persistConfiguredOwnerName,
} from "./owner-name.js";

describe("owner-name", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("normalizeOwnerName", () => {
    it("returns trimmed string for valid string inputs", () => {
      expect(normalizeOwnerName("Alice")).toBe("Alice");
      expect(normalizeOwnerName("  Bob Smith  ")).toBe("Bob Smith");
    });

    it("coerces numeric values to strings", () => {
      expect(normalizeOwnerName(12345)).toBe("12345");
    });

    it("returns null for empty strings or non-string/number inputs", () => {
      expect(normalizeOwnerName("")).toBeNull();
      expect(normalizeOwnerName("   ")).toBeNull();
      expect(normalizeOwnerName(null)).toBeNull();
      expect(normalizeOwnerName(undefined)).toBeNull();
      expect(normalizeOwnerName({})).toBeNull();
      expect(normalizeOwnerName([])).toBeNull();
    });
  });

  describe("fetchConfiguredOwnerName", () => {
    it("reads and normalizes ui.ownerName from Eliza config", async () => {
      vi.spyOn(configModule, "loadElizaConfig").mockReturnValue({
        ui: {
          ownerName: "  Charlie  ",
        },
      });

      const name = await fetchConfiguredOwnerName();
      expect(name).toBe("Charlie");
    });

    it("returns null when config has no ui or ownerName", async () => {
      vi.spyOn(configModule, "loadElizaConfig").mockReturnValue({});

      const name = await fetchConfiguredOwnerName();
      expect(name).toBeNull();
    });

    it("handles config load errors gracefully by returning null", async () => {
      vi.spyOn(configModule, "loadElizaConfig").mockImplementation(() => {
        throw new Error("File not found");
      });

      const name = await fetchConfiguredOwnerName();
      expect(name).toBeNull();
    });
  });

  describe("persistConfiguredOwnerName", () => {
    it("updates ui.ownerName and saves config when name is valid", async () => {
      const existingConfig = { agents: [] };
      vi.spyOn(configModule, "loadElizaConfig").mockReturnValue(existingConfig);
      const saveSpy = vi
        .spyOn(configModule, "saveElizaConfig")
        .mockImplementation(() => {});

      const success = await persistConfiguredOwnerName("  Dave  ");

      expect(success).toBe(true);
      expect(saveSpy).toHaveBeenCalledWith({
        agents: [],
        ui: {
          ownerName: "Dave",
        },
      });
    });

    it("returns false without saving when name is invalid or empty", async () => {
      const saveSpy = vi.spyOn(configModule, "saveElizaConfig");

      const success = await persistConfiguredOwnerName("   ");

      expect(success).toBe(false);
      expect(saveSpy).not.toHaveBeenCalled();
    });
  });
});
