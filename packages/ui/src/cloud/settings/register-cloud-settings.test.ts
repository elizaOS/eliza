// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { listSettingsSections } from "../../components/settings/settings-section-registry";
import {
  CLOUD_SETTINGS_GROUP_ID,
  listExtraSettingsGroups,
} from "./cloud-settings-group";
// Importing the barrel runs the side-effecting registration.
import "./index";

const CLOUD_SECTION_IDS = [
  "cloud-account",
  "cloud-billing",
  "cloud-api-keys",
  "cloud-applications",
  "cloud-monetization",
  "cloud-organization",
] as const;

const SECURITY_ADDITION_IDS = [
  "cloud-security",
  "cloud-plugin-grants",
] as const;

describe("register-cloud-settings", () => {
  it("registers the Cloud group between System and Security", () => {
    const cloud = listExtraSettingsGroups().find(
      (g) => g.id === CLOUD_SETTINGS_GROUP_ID,
    );
    expect(cloud).toBeDefined();
    expect(cloud?.label).toBe("Cloud");
    // 1.5 sits between System (built-in order 1) and Security (built-in order 2).
    expect(cloud?.order).toBeGreaterThan(1);
    expect(cloud?.order).toBeLessThan(2);
  });

  it("registers every Cloud-group section with group=cloud", () => {
    const byId = new Map(listSettingsSections().map((s) => [s.id, s]));
    for (const id of CLOUD_SECTION_IDS) {
      const section = byId.get(id);
      expect(section, `missing section ${id}`).toBeDefined();
      expect(section?.group).toBe(CLOUD_SETTINGS_GROUP_ID);
      expect(section?.Component).toBeTypeOf("function");
    }
  });

  it("registers the cloud Security additions into the security group with non-colliding ids", () => {
    const byId = new Map(listSettingsSections().map((s) => [s.id, s]));
    for (const id of SECURITY_ADDITION_IDS) {
      const section = byId.get(id);
      expect(section, `missing section ${id}`).toBeDefined();
      expect(section?.group).toBe("security");
    }
    // The built-in local Security + Permissions sections must NOT be overridden.
    expect(byId.get("cloud-security")?.id).not.toBe("security");
    expect(byId.get("cloud-plugin-grants")?.id).not.toBe("permissions");
  });
});
