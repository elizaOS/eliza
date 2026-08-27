/**
 * Single non-interactive availability notice for roadmap account-security
 * capabilities that are not live yet. Replaces four peer-level dead rows.
 */

import {
  SettingsGroup,
  SettingsRow,
  SettingsStack,
} from "../../../components/settings/settings-layout";
import { useCloudT } from "../../shell/CloudI18nProvider";
import {
  ACCOUNT_SECURITY_CAPABILITY_LABELS,
  type AccountSecurityCapability,
  formatCapabilityList,
} from "../account-security-capabilities";

export function UnavailableAccountSecurityNotice({
  unavailable,
}: {
  unavailable: readonly AccountSecurityCapability[];
}) {
  const t = useCloudT();
  if (unavailable.length === 0) return null;

  const names = unavailable.map((key) =>
    t(`cloud.security.unavailable.capability.${key}`, {
      defaultValue: ACCOUNT_SECURITY_CAPABILITY_LABELS[key],
    }),
  );
  const listed = formatCapabilityList(names);
  const summary = `${listed.charAt(0).toUpperCase()}${listed.slice(1)} ${
    unavailable.length === 1 ? "is" : "are"
  } not available on this server.`;

  return (
    <SettingsStack
      data-testid="cloud-unavailable-account-security"
      role="status"
    >
      <SettingsGroup
        title={t("cloud.security.unavailable.title", {
          defaultValue: "Not available yet",
        })}
        description={t("cloud.security.unavailable.description", {
          defaultValue:
            "These capabilities will appear here when they ship. They are not mixed with working controls.",
        })}
      >
        <SettingsRow
          label={t("cloud.security.unavailable.summary", {
            defaultValue: summary,
          })}
          description={t("cloud.security.unavailable.liveControls", {
            defaultValue:
              "Privacy switches and account deletion on this page are the live controls.",
          })}
        />
      </SettingsGroup>
    </SettingsStack>
  );
}
