/**
 * Guards the MVP settings declutter: the tabs hidden for MVP (Capabilities,
 * Apps, Cloud Connectors, Runtime, My Runtimes, Wallet & RPC, and the
 * consolidated-away standalone Background) drop out of the nav when Developer
 * Mode is off, but stay REGISTERED (kept, not deleted) so their routes/
 * deep-links still resolve and they reappear when Developer Mode is on.
 */
import { isViewVisible } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { getAllSettingsSections } from "./settings-sections";

const MVP_HIDDEN = [
  "capabilities",
  "apps",
  "app-permissions",
  "cloud-connectors",
  "runtime",
  "my-runtimes",
  "wallet-rpc",
  "background",
] as const;

const DEV_OFF = { developer: false, preview: false } as const;
const DEV_ON = { developer: true, preview: false } as const;

function sectionById(id: string) {
  return getAllSettingsSections().find((s) => s.id === id);
}

describe("MVP settings declutter", () => {
  it("keeps every hidden section registered (route/deep-link intact)", () => {
    for (const id of MVP_HIDDEN) {
      expect(
        sectionById(id),
        `section "${id}" is still registered`,
      ).toBeTruthy();
    }
  });

  it("hides every MVP section from the nav when Developer Mode is off", () => {
    for (const id of MVP_HIDDEN) {
      const section = sectionById(id);
      expect(
        section && isViewVisible(section, DEV_OFF),
        `section "${id}" is hidden with developer off`,
      ).toBe(false);
    }
  });

  it("re-surfaces the hidden sections in Developer Mode", () => {
    for (const id of MVP_HIDDEN) {
      const section = sectionById(id);
      expect(
        section && isViewVisible(section, DEV_ON),
        `section "${id}" reappears with developer on`,
      ).toBe(true);
    }
  });

  it("keeps the everyday sections visible with Developer Mode off", () => {
    for (const id of ["identity", "ai-model", "permissions", "appearance"]) {
      const section = sectionById(id);
      expect(
        section && isViewVisible(section, DEV_OFF),
        `section "${id}" stays visible`,
      ).toBe(true);
    }
  });
});
