/** Verifies that connected-account footer routes resolve to mounted canonical Cloud sections. */
import { describe, expect, it } from "vitest";
import {
  cloudPanelAccountFooterSections,
  groupedCloudPanelSections,
  resolveCloudPanelSection,
} from "./cloud-panel-sections";

const ACCOUNT_FOOTER_SECTION_IDS = [
  "cloud-billing",
  "cloud-api-keys",
  "cloud-security",
  "cloud-organization",
] as const;

describe("cloud panel account footer sections", () => {
  it("registers every account action as a resolvable mounted section", () => {
    const footerSections = cloudPanelAccountFooterSections();

    expect(footerSections.map((section) => section.id)).toEqual(
      ACCOUNT_FOOTER_SECTION_IDS,
    );
    for (const sectionId of ACCOUNT_FOOTER_SECTION_IDS) {
      expect(resolveCloudPanelSection(sectionId)).toBe(sectionId);
    }
  });

  it("keeps account-only destinations out of the primary sidebar and narrow hub", () => {
    const primaryIds = Object.values(groupedCloudPanelSections())
      .flat()
      .map((section) => section.id);

    expect(primaryIds).not.toEqual(
      expect.arrayContaining([...ACCOUNT_FOOTER_SECTION_IDS]),
    );
  });
});
