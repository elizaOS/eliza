/** Verifies register-cloud-settings through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * `registerCloudSettingsSections` populates the shared settings-section
 * registry: the Cloud group lands between System and Security and Developer
 * between Cloud and Security, every account/management/security section is
 * visible for a managed Cloud runtime, and the Cloud security additions merge
 * into the security group with non-colliding ids.
 */

import { isViewVisible } from "@elizaos/core";
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

  it("registers every Cloud-group section as a managed-runtime surface", () => {
    const byId = new Map(listSettingsSections().map((s) => [s.id, s]));
    for (const id of CLOUD_SECTION_IDS) {
      const section = byId.get(id);
      expect(section, `missing section ${id}`).toBeDefined();
      expect(section?.group).toBe(CLOUD_SETTINGS_GROUP_ID);
      expect(section?.Component).toBeTypeOf("function");
      expect(section?.developerOnly).not.toBe(true);
      expect(section?.cloudOnly).toBe(true);
    }
  });

  it("promotes API, applications, and monetization for managed runtimes", () => {
    const byId = new Map(listSettingsSections().map((s) => [s.id, s]));
    for (const id of DEVELOPER_SECTION_IDS) {
      const section = byId.get(id);
      expect(section, `missing section ${id}`).toBeDefined();
      expect(section?.group).toBe(DEVELOPER_SETTINGS_GROUP_ID);
      expect(section?.viewKind).toBe("release");
      expect(section?.cloudOnly).toBe(true);
      expect(section?.Component).toBeTypeOf("function");
    }
  });

  it("keeps Cloud Connectors registered for direct access with Developer Mode off", () => {
    const connector = listSettingsSections().find(
      (section) => section.id === "cloud-connectors",
    );

    expect(connector).toBeDefined();
    expect(connector?.viewKind).toBe("release");
    expect(connector?.prominence).toBe("secondary");
    expect(connector?.developerOnly).not.toBe(true);
    expect(connector?.cloudOnly).toBe(true);
    expect(
      connector &&
        isViewVisible(connector, { developer: false, preview: false }),
    ).toBe(true);
  });

  it("registers the cloud Security additions into the security group with non-colliding ids", () => {
    const byId = new Map(listSettingsSections().map((s) => [s.id, s]));
    for (const id of SECURITY_ADDITION_IDS) {
      const section = byId.get(id);
      expect(section, `missing section ${id}`).toBeDefined();
      expect(section?.group).toBe("security");
      expect(section?.cloudOnly).toBe(true);
    }
    // The built-in local Security + Permissions sections must NOT be overridden.
    expect(byId.get("cloud-security")?.id).not.toBe("security");
    expect(byId.get("cloud-plugin-grants")?.id).not.toBe("permissions");
  });
});
