// @vitest-environment jsdom

/**
 * `registerCloudSettingsSections` populates the shared settings-section
 * registry: the Cloud group lands between System and Security and Developer
 * between Cloud and Security, plain users see the cloud sections while the
 * developer sections stay gated, and the cloud Security additions merge into
 * the security group with non-colliding ids.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { listSettingsSections } from "../../components/settings/settings-section-registry";
import {
  CLOUD_SETTINGS_GROUP_ID,
  DEVELOPER_SETTINGS_GROUP_ID,
  listExtraSettingsGroups,
} from "./cloud-settings-group";
import { registerCloudSettingsSections } from "./register-cloud-settings";

const CLOUD_SECTION_IDS = [
  "cloud-account",
  "cloud-billing",
  "cloud-organization",
] as const;

const DEVELOPER_SECTION_IDS = [
  "cloud-api-keys",
  "cloud-applications",
  "cloud-monetization",
] as const;

const SECURITY_ADDITION_IDS = [
  "cloud-security",
  "cloud-plugin-grants",
] as const;

describe("register-cloud-settings", () => {
  beforeAll(() => {
    registerCloudSettingsSections();
  });

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

  it("registers the Developer group between Cloud and Security", () => {
    const developer = listExtraSettingsGroups().find(
      (g) => g.id === DEVELOPER_SETTINGS_GROUP_ID,
    );
    expect(developer).toBeDefined();
    expect(developer?.label).toBe("Developer");
    expect(developer?.order).toBeGreaterThan(1.5);
    expect(developer?.order).toBeLessThan(2);
  });

  it("registers every Cloud-group section with group=cloud, visible to a plain user", () => {
    const byId = new Map(listSettingsSections().map((s) => [s.id, s]));
    for (const id of CLOUD_SECTION_IDS) {
      const section = byId.get(id);
      expect(section, `missing section ${id}`).toBeDefined();
      expect(section?.group).toBe(CLOUD_SETTINGS_GROUP_ID);
      expect(section?.Component).toBeTypeOf("function");
      // Account / Billing / Organization stay in normal Settings — no developer
      // gate, so a plain USER role sees them.
      expect(section?.viewKind).not.toBe("developer");
      expect(section?.viewKind).not.toBe("preview");
      expect(section?.developerOnly).not.toBe(true);
    }
  });

  it("hides the developer cloud sections from a plain user via the developer view gate", () => {
    const byId = new Map(listSettingsSections().map((s) => [s.id, s]));
    for (const id of DEVELOPER_SECTION_IDS) {
      const section = byId.get(id);
      expect(section, `missing section ${id}`).toBeDefined();
      expect(section?.group).toBe(DEVELOPER_SETTINGS_GROUP_ID);
      // viewKind "developer" is the gate input the SettingsView reads to hide
      // these from a non-developer USER role (dev builds default the toggle on;
      // prod defaults it off).
      expect(section?.viewKind).toBe("developer");
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
