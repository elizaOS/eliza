/**
 * In-app Eliza Cloud settings sections (re-IA Step 2).
 *
 * Importing this module registers the Cloud settings group + every cloud
 * settings section (and the two Security-group additions) via the side-effecting
 * {@link ./register-cloud-settings}. The Settings view imports it so the cloud
 * sections are present whenever settings render — web and native alike — the same
 * way the built-in sections register through `settings-sections.ts`.
 */

import "./register-cloud-settings";

export { CloudSettingsSectionShell } from "./CloudSettingsSectionShell";
export {
  CLOUD_SETTINGS_GROUP_ID,
  type ExtraSettingsGroupDef,
  getExtraSettingsGroup,
  listExtraSettingsGroups,
  registerSettingsGroup,
} from "./cloud-settings-group";
export {
  CloudAccountSection,
  CloudApiKeysSection,
  CloudApplicationsSection,
  CloudBillingSection,
  CloudMonetizationSection,
  CloudOrganizationSection,
  CloudPluginGrantsSection,
  CloudSecuritySection,
} from "./sections";
