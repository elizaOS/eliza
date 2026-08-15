/**
 * Settings → Cloud Applications entry: a single nav row that opens the
 * standalone `/cloud/apps` developer surface.
 */
import { Grid3x3 } from "lucide-react";
import {
  SettingsGroup,
  SettingsRow,
  SettingsStack,
} from "../../components/settings/settings-layout";
import { useCloudT } from "../shell/CloudI18nProvider";

export function ApplicationsEntry(): React.JSX.Element {
  const t = useCloudT();
  const open = () => {
    if (typeof window !== "undefined") {
      window.location.assign("/cloud/apps");
    }
  };
  return (
    <SettingsStack data-testid="cloud-applications-entry">
      <SettingsGroup>
        <SettingsRow
          icon={Grid3x3}
          label={t("cloud.applications.entryTitle", {
            defaultValue: "Manage applications",
          })}
          description={t("cloud.applications.entryDescription", {
            defaultValue:
              "Cloud OAuth applications: monetization, earnings, domains, analytics, users.",
          })}
          onClick={open}
        />
      </SettingsGroup>
    </SettingsStack>
  );
}
