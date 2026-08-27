/**
 * Unit tests for shared system permission contracts and identifiers.
 * Validates canonical permission ID registry and type guard predicate.
 */
import { describe, expect, it } from "vitest";
import {
  isPermissionId,
  PERMISSION_DEFINITIONS,
  PERMISSION_IDS,
} from "../permissions.ts";

describe("permissions contract", () => {
  describe("PERMISSION_IDS", () => {
    it("contains all 28 canonical system permission identifiers", () => {
      expect(PERMISSION_IDS).toHaveLength(28);
      expect(PERMISSION_IDS).toContain("screen-recording");
      expect(PERMISSION_IDS).toContain("accessibility");
      expect(PERMISSION_IDS).toContain("reminders");
      expect(PERMISSION_IDS).toContain("calendar");
      expect(PERMISSION_IDS).toContain("health");
      expect(PERMISSION_IDS).toContain("screentime");
      expect(PERMISSION_IDS).toContain("contacts");
      expect(PERMISSION_IDS).toContain("notes");
      expect(PERMISSION_IDS).toContain("microphone");
      expect(PERMISSION_IDS).toContain("camera");
      expect(PERMISSION_IDS).toContain("location");
      expect(PERMISSION_IDS).toContain("shell");
      expect(PERMISSION_IDS).toContain("website-blocking");
      expect(PERMISSION_IDS).toContain("notifications");
      expect(PERMISSION_IDS).toContain("full-disk");
      expect(PERMISSION_IDS).toContain("automation");
      expect(PERMISSION_IDS).toContain("speech-recognition");
      expect(PERMISSION_IDS).toContain("photos");
      expect(PERMISSION_IDS).toContain("phone");
      expect(PERMISSION_IDS).toContain("messages");
      expect(PERMISSION_IDS).toContain("wifi");
      expect(PERMISSION_IDS).toContain("bluetooth");
      expect(PERMISSION_IDS).toContain("app-blocking");
      expect(PERMISSION_IDS).toContain("usage-access");
      expect(PERMISSION_IDS).toContain("overlay");
      expect(PERMISSION_IDS).toContain("write-settings");
      expect(PERMISSION_IDS).toContain("local-network");
      expect(PERMISSION_IDS).toContain("battery-optimization");
    });

    it("is derived one-to-one from the canonical metadata catalog", () => {
      expect(PERMISSION_DEFINITIONS.map(({ id }) => id)).toEqual(
        PERMISSION_IDS,
      );
      expect(new Set(PERMISSION_IDS).size).toBe(PERMISSION_IDS.length);
      for (const definition of PERMISSION_DEFINITIONS) {
        expect(definition.name).not.toBe("");
        expect(definition.description).not.toBe("");
        expect(definition.icon).not.toBe("");
      }
    });
  });

  describe("isPermissionId", () => {
    it("returns true for every valid PermissionId", () => {
      for (const id of PERMISSION_IDS) {
        expect(isPermissionId(id)).toBe(true);
      }
    });

    it("returns false for non-permission strings", () => {
      expect(isPermissionId("")).toBe(false);
      expect(isPermissionId("root")).toBe(false);
      expect(isPermissionId("admin")).toBe(false);
      expect(isPermissionId("SCREEN-RECORDING")).toBe(false);
    });

    it("returns false for non-string values", () => {
      expect(isPermissionId(null)).toBe(false);
      expect(isPermissionId(undefined)).toBe(false);
      expect(isPermissionId(123)).toBe(false);
      expect(isPermissionId({})).toBe(false);
      expect(isPermissionId([])).toBe(false);
    });
  });
});
