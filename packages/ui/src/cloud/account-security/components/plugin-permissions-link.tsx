/**
 * Nav row from the Security section to the plugin-grants settings section
 * (`/settings#cloud-plugin-grants`). Uses a real hash anchor so SettingsView
 * sees `hashchange` on section switches, including middle-click / new-tab.
 */

import {
  SettingsGroup,
  SettingsRow,
  SettingsStack,
} from "../../../components/settings/settings-layout";
import { useCloudT } from "../../shell/CloudI18nProvider";

export function PluginPermissionsLink() {
  const t = useCloudT();
  return (
    <SettingsStack data-testid="cloud-plugin-permissions-link">
      <SettingsGroup>
        <SettingsRow
          label={t("cloud.security.pluginPermissionsLink", {
            defaultValue: "Plugin permissions",
          })}
          control={
            <a
              href="#cloud-plugin-grants"
              className="text-sm font-medium text-accent underline-offset-2 hover:underline"
            >
              {t("cloud.security.pluginPermissionsManage", {
                defaultValue: "Manage permissions",
              })}
            </a>
          }
        />
      </SettingsGroup>
    </SettingsStack>
  );
}
