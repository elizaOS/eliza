/** Exercises permission identifier guards with accepted and invalid inputs. */
import { describe, expect, it } from "vitest";
import { isPermissionId, PERMISSION_IDS } from "../permissions.ts";

describe("permissions contract", () => {
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
