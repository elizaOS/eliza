/**
 * In-app Eliza Cloud settings sections.
 *
 * This barrel is intentionally side-effect free. Hosts that expose the Cloud
 * dashboard inside Settings must call {@link registerCloudSettingsSections}
 * from their cloud boot path; local-first shells can import Cloud helpers
 * without surfacing Cloud-only tabs.
 */

export { CloudSettingsSectionShell } from "./CloudSettingsSectionShell";
export {
  CLOUD_SETTINGS_GROUP_ID,
  type ExtraSettingsGroupDef,
  getExtraSettingsGroup,
  listExtraSettingsGroups,
  registerSettingsGroup,
} from "./cloud-settings-group";
export { registerCloudSettingsSections } from "./register-cloud-settings";
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
