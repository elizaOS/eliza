/**
 * Pure presentation-contract coverage for global permission badges and actions,
 * including limited access that must never render as a full grant.
 */
import { describe, expect, it } from "vitest";
import {
  getPermissionAction,
  getPermissionBadge,
  resolveSystemPermissionsForPlatform,
} from "./permission-types";

const untranslated = (key: string) => key;

describe("permission presentation", () => {
  it("does not advertise Apple Speech Recognition in cloud-only iOS", () => {
    const cloudIds = resolveSystemPermissionsForPlatform("ios", {
      cloudOnly: true,
    }).map((permission) => permission.id);
    const localIds = resolveSystemPermissionsForPlatform("ios").map(
      (permission) => permission.id,
    );

    expect(cloudIds).not.toContain("speech-recognition");
    expect(cloudIds).toContain("microphone");
    expect(cloudIds).toContain("notifications");
    expect(localIds).toContain("speech-recognition");
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
