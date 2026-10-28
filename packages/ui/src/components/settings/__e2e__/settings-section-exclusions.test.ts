/**
 * A host product can withhold Settings sections it never offers (for example local backups in a
 * product without app-data transfer, or wallet RPC in a product without Wallet). The same gate
 * decides hub visibility and deep-link resolution, so an excluded section cannot be opened.
 */
import { Settings } from "lucide-react";
import { expect, it } from "vitest";
import {
  excludeSettingsSections,
  getSettingsSectionRegistryVersion,
  registerSettingsSection,
  type SettingsSectionDef,
  settingsSectionExcluded,
  settingsSectionIsAvailable,
  subscribeSettingsSections,
} from "../settings-section-registry";

const capabilities = new Set<never>();

function section(id: string): SettingsSectionDef {
  return {
    id,
    label: `settings.sections.${id}.label`,
    defaultLabel: id,
    icon: Settings,
    tone: "neutral",
    hue: "slate",
    titleKey: `settings.sections.${id}.label`,
    defaultTitle: id,
    group: "system",
    Component: () => null,
  };
}

it("hides and refuses excluded sections, and re-registration does not restore them", () => {
  const backups = section("exclusion-fixture-backups");
  const walletRpc = section("exclusion-fixture-wallet-rpc");
  const kept = section("exclusion-fixture-appearance");
  for (const entry of [backups, walletRpc, kept]) registerSettingsSection(entry);
  for (const entry of [backups, walletRpc, kept])
    expect(settingsSectionIsAvailable(entry, capabilities)).toBe(true);

  let notified = 0;
  const unsubscribe = subscribeSettingsSections(() => {
    notified += 1;
  });
  const before = getSettingsSectionRegistryVersion();
  excludeSettingsSections([backups.id, walletRpc.id]);
  expect(getSettingsSectionRegistryVersion()).toBeGreaterThan(before);
  expect(notified).toBe(1);
  expect(settingsSectionExcluded(backups.id)).toBe(true);
  expect(settingsSectionIsAvailable(backups, capabilities)).toBe(false);
  expect(settingsSectionIsAvailable(walletRpc, capabilities)).toBe(false);
  expect(settingsSectionIsAvailable(kept, capabilities)).toBe(true);

  // A plugin or host registering the same id later cannot bring it back.
  registerSettingsSection({ ...backups, defaultLabel: "Backups again" });
  expect(settingsSectionIsAvailable(backups, capabilities)).toBe(false);

  // Repeated or empty ids change nothing and do not re-render.
  const settled = getSettingsSectionRegistryVersion();
  notified = 0;
  excludeSettingsSections([backups.id, ""]);
  expect(getSettingsSectionRegistryVersion()).toBe(settled);
  expect(notified).toBe(0);
  unsubscribe();
});
