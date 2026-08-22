/** Tests the pure experience-policy seam without rendering application shells. */
import { describe, expect, it } from "vitest";
import {
  isSettingsSectionAvailable,
  resolveSettingsExperience,
} from "./settings-experience";
import type { SettingsSectionDef } from "./settings-section-registry";

function section(
  policy: Pick<
    SettingsSectionDef,
    "cloudOnly" | "experiences" | "hideOnCloud" | "hideOnManagedCloud"
  >,
): SettingsSectionDef {
  return policy as SettingsSectionDef;
}

describe("settings experience policy", () => {
  it("distinguishes consumer Cloud branding from managed Cloud runtime", () => {
    expect(
      resolveSettingsExperience({
        cloudOnlyBranding: true,
        managedCloudRuntime: true,
      }),
    ).toBe("consumer-cloud");
    expect(
      resolveSettingsExperience({
        cloudOnlyBranding: false,
        managedCloudRuntime: true,
      }),
    ).toBe("managed-cloud");
  });

  it("uses explicit experience policy when a section declares it", () => {
    const consumerSection = section({ experiences: ["consumer-cloud"] });
    expect(
      isSettingsSectionAvailable(consumerSection, {
        experience: "consumer-cloud",
        androidCloudBuild: false,
      }),
    ).toBe(true);
    expect(
      isSettingsSectionAvailable(consumerSection, {
        experience: "managed-cloud",
        androidCloudBuild: false,
      }),
    ).toBe(false);
  });

  it("preserves legacy Cloud and Android filtering during migration", () => {
    expect(
      isSettingsSectionAvailable(section({ cloudOnly: true }), {
        experience: "standard",
        androidCloudBuild: false,
      }),
    ).toBe(false);
    expect(
      isSettingsSectionAvailable(section({ hideOnManagedCloud: true }), {
        experience: "consumer-cloud",
        androidCloudBuild: false,
      }),
    ).toBe(false);
    expect(
      isSettingsSectionAvailable(section({ hideOnCloud: true }), {
        experience: "consumer-cloud",
        androidCloudBuild: true,
      }),
    ).toBe(false);
  });
});
