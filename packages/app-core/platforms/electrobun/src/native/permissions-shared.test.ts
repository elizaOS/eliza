/**
 * Exercises SYSTEM_PERMISSIONS catalog membership and isPermissionApplicable
 * platform lookup against the real Electrobun permissions-shared module.
 */
import { PERMISSION_IDS } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import {
  isPermissionApplicable,
  type Platform,
  SYSTEM_PERMISSIONS,
  type SystemPermissionId,
} from "./permissions-shared";

const ALL_PLATFORMS: Platform[] = [
  "darwin",
  "win32",
  "linux",
  "ios",
  "android",
  "web",
];

const CATALOG_ORDER: SystemPermissionId[] = [
  "accessibility",
  "screen-recording",
  "microphone",
  "camera",
  "shell",
  "website-blocking",
  "location",
  "reminders",
  "calendar",
  "health",
  "screentime",
  "contacts",
  "notes",
  "notifications",
  "full-disk",
  "automation",
  "speech-recognition",
  "photos",
  "phone",
  "messages",
  "wifi",
  "bluetooth",
  "app-blocking",
  "usage-access",
  "overlay",
  "write-settings",
  "local-network",
  "battery-optimization",
];

describe("SYSTEM_PERMISSIONS", () => {
  it("exports a non-empty catalog", () => {
    expect(SYSTEM_PERMISSIONS.length).toBeGreaterThan(0);
  });

  it("keeps unique ids so the lookup map is one-to-one", () => {
    const ids = SYSTEM_PERMISSIONS.map((permission) => permission.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("preserves catalog order from accessibility through battery-optimization", () => {
    expect(SYSTEM_PERMISSIONS.map((permission) => permission.id)).toEqual(
      CATALOG_ORDER,
    );
  });

  it("gives every definition required fields and only known platforms", () => {
    for (const definition of SYSTEM_PERMISSIONS) {
      expect(definition.name.length).toBeGreaterThan(0);
      expect(definition.description.length).toBeGreaterThan(0);
      expect(definition.icon.length).toBeGreaterThan(0);
      expect(definition.platforms.length).toBeGreaterThan(0);
      expect(definition.requiredForFeatures.length).toBeGreaterThan(0);
      for (const platform of definition.platforms) {
        expect(ALL_PLATFORMS).toContain(platform);
      }
    }
  });

  it("covers every canonical PermissionId from the shared contract", () => {
    const catalogIds = new Set(
      SYSTEM_PERMISSIONS.map((permission) => permission.id),
    );
    expect(catalogIds.size).toBe(PERMISSION_IDS.length);
    for (const id of PERMISSION_IDS) {
      expect(catalogIds.has(id)).toBe(true);
    }
  });
});

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
      isPermissionApplicable(
        "not-a-permission" as SystemPermissionId,
        "darwin",
      ),
    ).toBe(false);
  });

  it("returns false for an empty-string id treated as a missing catalog entry", () => {
    expect(isPermissionApplicable("" as SystemPermissionId, "android")).toBe(
      false,
    );
  });

  it("treats a single-platform android permission as inapplicable elsewhere", () => {
    expect(isPermissionApplicable("phone", "android")).toBe(true);
    for (const platform of ALL_PLATFORMS.filter(
      (value) => value !== "android",
    )) {
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

  it("treats speech-recognition as applicable on ios and web only", () => {
    expect(isPermissionApplicable("speech-recognition", "ios")).toBe(true);
    expect(isPermissionApplicable("speech-recognition", "web")).toBe(true);
    expect(isPermissionApplicable("speech-recognition", "darwin")).toBe(false);
    expect(isPermissionApplicable("speech-recognition", "win32")).toBe(false);
    expect(isPermissionApplicable("speech-recognition", "linux")).toBe(false);
    expect(isPermissionApplicable("speech-recognition", "android")).toBe(false);
  });

  it("treats photos as applicable on ios, android, and web", () => {
    expect(isPermissionApplicable("photos", "ios")).toBe(true);
    expect(isPermissionApplicable("photos", "android")).toBe(true);
    expect(isPermissionApplicable("photos", "web")).toBe(true);
    expect(isPermissionApplicable("photos", "darwin")).toBe(false);
    expect(isPermissionApplicable("photos", "win32")).toBe(false);
    expect(isPermissionApplicable("photos", "linux")).toBe(false);
  });

  it("looks up the last catalog entry independently of array position", () => {
    const last = SYSTEM_PERMISSIONS.at(-1);
    expect(last?.id).toBe("battery-optimization");
    expect(isPermissionApplicable("battery-optimization", "android")).toBe(
      true,
    );
    expect(isPermissionApplicable("battery-optimization", "darwin")).toBe(
      false,
    );
  });
});
