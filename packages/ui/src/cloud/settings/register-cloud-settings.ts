/**
 * Single registration barrel for the in-app Eliza Cloud settings sections.
 *
 * Calling {@link registerCloudSettingsSections} registers:
 *  - new **Cloud** and **Developer** settings groups (between System and
 *    Security), and
 *  - the cloud sections that re-home the lifted cloud dashboard pages as in-app
 *    Settings sections, plus two additions to the existing **Security** group.
 *
 * Every section is registered through {@link registerSettingsSection} (the
 * pluggable registry) — never the pinned `settings-section-meta.ts` list — so the
 * built-in section count the app-core `dev-route-catalog` parity test pins stays
 * unchanged, exactly like the existing `cloud-agents` section does.
 *
 * Section → source domain:
 *  | id                    | group    | source domain (`cloud/<domain>/`)        |
 *  |-----------------------|----------|------------------------------------------|
 *  | cloud-account         | cloud    | account-security (AccountSurface)        |
 *  | cloud-billing         | cloud    | billing (BillingSectionBody + invoices)  |
 *  | cloud-api-keys        | developer| api-keys (ApiKeysSurface)                |
 *  | cloud-applications    | developer| applications (entry → /dashboard/apps)   |
 *  | cloud-monetization    | developer| monetization (Earnings + Affiliates)     |
 *  | cloud-organization    | cloud    | organization (OrganizationSection)       |
 *  | cloud-security        | security | account-security (SecuritySurface)       |
 *  | cloud-plugin-grants   | security | account-security (PermissionsSurface)    |
 *
 * Note on ids: the cloud Security/Plugin-grants surfaces deliberately use the
 * `cloud-security` / `cloud-plugin-grants` ids (NOT `security` / `permissions`),
 * so they sit *alongside* the app's built-in local Security + Permissions
 * sections rather than overriding them (the registry is last-write-wins per id).
 */

import {
  Building2,
  CreditCard,
  Grid3x3,
  KeyRound,
  Lock,
  TrendingUp,
  User,
  Workflow,
} from "lucide-react";
import { registerSettingsSection } from "../../components/settings/settings-section-registry";
import { registerCloudConnectorsSettingsSection } from "../connectors";
import { registerMcpsSettingsSection } from "../mcps";
import {
  CLOUD_SETTINGS_GROUP_ID,
  DEVELOPER_SETTINGS_GROUP_ID,
  registerSettingsGroup,
} from "./cloud-settings-group";
import {
  CloudAccountSection,
  CloudApiKeysSection,
  CloudApplicationsSection,
  CloudBillingSection,
  CloudMonetizationSection,
  CloudOrganizationSection,
  CloudPluginGrantsSection,
  CloudSecuritySection,
} from "./sections";

/**
 * The Cloud + Developer groups sit between System (built-in order 1) and
 * Security (built-in order 2).
 */
let cloudSettingsRegistered = false;

export function registerCloudSettingsSections(): void {
  if (cloudSettingsRegistered) return;
  cloudSettingsRegistered = true;

  registerSettingsGroup({
    id: CLOUD_SETTINGS_GROUP_ID,
    label: "Cloud",
    order: 1.5,
  });

  registerSettingsGroup({
    id: DEVELOPER_SETTINGS_GROUP_ID,
    label: "Developer",
    order: 1.6,
  });

  // ── Cloud group ──────────────────────────────────────────────────────────────

  registerSettingsSection({
    id: "cloud-account",
    label: "settings.sections.cloudAccount.label",
    defaultLabel: "Account & Profile",
    icon: User,
    tone: "accent",
    hue: "accent",
    group: CLOUD_SETTINGS_GROUP_ID,
    titleKey: "settings.sections.cloudAccount.title",
    defaultTitle: "Account & Profile",
    order: 0,
    Component: CloudAccountSection,
  });

  registerSettingsSection({
    id: "cloud-billing",
    label: "settings.sections.cloudBilling.label",
    defaultLabel: "Billing & Credits",
    icon: CreditCard,
    tone: "accent",
    hue: "accent",
    group: CLOUD_SETTINGS_GROUP_ID,
    titleKey: "settings.sections.cloudBilling.title",
    defaultTitle: "Billing & Credits",
    order: 1,
    Component: CloudBillingSection,
  });

  registerSettingsSection({
    id: "cloud-api-keys",
    label: "settings.sections.cloudApiKeys.label",
    defaultLabel: "API Keys",
    icon: KeyRound,
    tone: "accent",
    hue: "accent",
    group: DEVELOPER_SETTINGS_GROUP_ID,
    titleKey: "settings.sections.cloudApiKeys.title",
    defaultTitle: "API Keys",
    order: 0,
    viewKind: "developer",
    Component: CloudApiKeysSection,
  });

  registerSettingsSection({
    id: "cloud-applications",
    label: "settings.sections.cloudApplications.label",
    defaultLabel: "Applications",
    icon: Grid3x3,
    tone: "accent",
    hue: "accent",
    group: DEVELOPER_SETTINGS_GROUP_ID,
    titleKey: "settings.sections.cloudApplications.title",
    defaultTitle: "Applications",
    order: 1,
    viewKind: "developer",
    Component: CloudApplicationsSection,
  });

  registerSettingsSection({
    id: "cloud-monetization",
    label: "settings.sections.cloudMonetization.label",
    defaultLabel: "Monetization",
    icon: TrendingUp,
    tone: "accent",
    hue: "accent",
    group: DEVELOPER_SETTINGS_GROUP_ID,
    titleKey: "settings.sections.cloudMonetization.title",
    defaultTitle: "Monetization",
    order: 2,
    viewKind: "developer",
    Component: CloudMonetizationSection,
  });

  registerSettingsSection({
    id: "cloud-organization",
    label: "settings.sections.cloudOrganization.label",
    defaultLabel: "Organization",
    icon: Building2,
    tone: "accent",
    hue: "accent",
    group: CLOUD_SETTINGS_GROUP_ID,
    titleKey: "settings.sections.cloudOrganization.title",
    defaultTitle: "Organization",
    order: 2,
    Component: CloudOrganizationSection,
  });

  // ── Security group (additions) ───────────────────────────────────────────────
  // Ordered after the built-in security sections (built-ins occupy meta indices
  // 12–15). High explicit order keeps them last within the Security group.

  registerSettingsSection({
    id: "cloud-security",
    label: "settings.sections.cloudSecurity.label",
    defaultLabel: "Sessions & Privacy",
    icon: Lock,
    tone: "warn",
    hue: "amber",
    group: "security",
    titleKey: "settings.sections.cloudSecurity.title",
    defaultTitle: "Sessions, Privacy & Audit",
    order: 100,
    Component: CloudSecuritySection,
  });

  registerSettingsSection({
    id: "cloud-plugin-grants",
    label: "settings.sections.cloudPluginGrants.label",
    defaultLabel: "Plugin Grants",
    icon: Workflow,
    tone: "warn",
    hue: "amber",
    group: "security",
    titleKey: "settings.sections.cloudPluginGrants.title",
    defaultTitle: "Plugin Grants",
    order: 101,
    Component: CloudPluginGrantsSection,
  });

  // ── Cloud connectors + MCPs ──────────────────────────────────────────────────
  // These domains own their own settings-section registration (they live outside
  // cloud/settings/). Invoke them here — from the barrel that SettingsView imports
  // on every platform — so the sections surface on web AND native/desktop, not
  // only inside the web-only route aggregator (register-all.ts).
  registerCloudConnectorsSettingsSection();
  registerMcpsSettingsSection();
}
