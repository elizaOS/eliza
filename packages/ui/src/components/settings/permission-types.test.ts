/**
 * Pure presentation-contract coverage for global permission badges and actions,
 * including limited access that must never render as a full grant.
 */

import { PERMISSION_DEFINITIONS, PERMISSION_IDS } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import {
  getPermissionAction,
  getPermissionBadge,
  SYSTEM_PERMISSIONS,
  UI_PERMISSION_DISPLAY_PLATFORMS,
} from "./permission-types";

const untranslated = (key: string) => key;

describe("permission presentation", () => {
  it("projects every shared definition exactly once with UI-only fields", () => {
    expect(SYSTEM_PERMISSIONS.map(({ id }) => id)).toEqual(PERMISSION_IDS);
    expect(Object.keys(UI_PERMISSION_DISPLAY_PLATFORMS).sort()).toEqual(
      [...PERMISSION_IDS].sort(),
    );

    for (const definition of SYSTEM_PERMISSIONS) {
      const shared = PERMISSION_DEFINITIONS.find(
        ({ id }) => id === definition.id,
      );
      expect(shared).toBeDefined();
      expect(definition.name).toBe(shared?.name);
      expect(definition.description).toBe(shared?.description);
      expect(definition.icon).toBe(shared?.icon);
      expect(definition.requiredForFeatures).toBe(shared?.requiredForFeatures);
      expect(definition.nameKey).toMatch(
        /^permissionssection\.permission\.[a-zA-Z]+\.name$/u,
      );
      expect(definition.descriptionKey).toMatch(
        /^permissionssection\.permission\.[a-zA-Z]+\.description$/u,
      );
    }
  });

  it("renders limited calendar access as limited with an upgrade action", () => {
    expect(
      getPermissionBadge(untranslated, "calendar", "limited", "ios"),
    ).toEqual({
      tone: "warning",
      label: "Limited",
    });
    expect(
      getPermissionAction(untranslated, "calendar", "limited", true, "ios"),
    ).toEqual({
      ariaLabelPrefix: "Upgrade access",
      label: "Upgrade access",
      type: "request",
    });
  });

  it("routes a non-requestable limited permission to settings", () => {
    expect(
      getPermissionAction(untranslated, "photos", "limited", false, "ios"),
    ).toEqual({
      ariaLabelPrefix: "Manage",
      label: "Manage",
      type: "settings",
    });
  });

  it("preserves the existing full-grant presentation", () => {
    expect(
      getPermissionBadge(untranslated, "calendar", "granted", "ios"),
    ).toEqual({
      tone: "success",
      label: "Granted",
    });
  });
});
