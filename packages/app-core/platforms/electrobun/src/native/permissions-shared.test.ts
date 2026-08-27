/**
 * Exercises SYSTEM_PERMISSIONS catalog membership and isPermissionApplicable
 * platform lookup against the real Electrobun permissions-shared module.
 */
import { describe, expect, it } from "vitest";
import {
  isPermissionApplicable,
  type PermissionId,
  type Platform,
  SYSTEM_PERMISSIONS,
} from "./permissions-shared";

const ALL_PLATFORMS: Platform[] = [
  "darwin",
  "win32",
  "linux",
  "ios",
  "android",
  "web",
];

describe("isPermissionApplicable", () => {
  it("returns true only when the definition lists the platform", () => {
    for (const definition of SYSTEM_PERMISSIONS) {
      for (const platform of ALL_PLATFORMS) {
        expect(isPermissionApplicable(definition.id, platform)).toBe(
          definition.platforms.includes(platform),
        );
      }
    }
  });

  it("returns false for a missing permission id", () => {
    expect(
      isPermissionApplicable("not-a-permission" as PermissionId, "darwin"),
    ).toBe(false);
  });

  it("returns false for an empty-string id treated as a missing catalog entry", () => {
    expect(isPermissionApplicable("" as PermissionId, "android")).toBe(false);
  });

  it("does not claim mobile permissions in the desktop implementation", () => {
    for (const platform of ALL_PLATFORMS) {
      expect(isPermissionApplicable("phone", platform)).toBe(false);
    }
  });

  it("treats a single-platform darwin permission as inapplicable elsewhere", () => {
    expect(isPermissionApplicable("accessibility", "darwin")).toBe(true);
    for (const platform of ALL_PLATFORMS.filter(
      (value) => value !== "darwin",
    )) {
      expect(isPermissionApplicable("accessibility", platform)).toBe(false);
    }
  });

  it("treats desktop microphone as applicable on darwin, win32, and linux only", () => {
    expect(isPermissionApplicable("microphone", "darwin")).toBe(true);
    expect(isPermissionApplicable("microphone", "win32")).toBe(true);
    expect(isPermissionApplicable("microphone", "linux")).toBe(true);
    expect(isPermissionApplicable("microphone", "ios")).toBe(false);
    expect(isPermissionApplicable("microphone", "android")).toBe(false);
    expect(isPermissionApplicable("microphone", "web")).toBe(false);
  });

  it("does not project mobile and web-only integrations into Electrobun", () => {
    for (const id of ["speech-recognition", "photos"] as const) {
      for (const platform of ALL_PLATFORMS) {
        expect(isPermissionApplicable(id, platform)).toBe(false);
      }
    }
  });

  it("looks up the last catalog entry independently of array position", () => {
    const last = SYSTEM_PERMISSIONS.at(-1);
    expect(last?.id).toBe("battery-optimization");
    expect(isPermissionApplicable("battery-optimization", "android")).toBe(
      false,
    );
    expect(isPermissionApplicable("battery-optimization", "darwin")).toBe(
      false,
    );
  });
});
