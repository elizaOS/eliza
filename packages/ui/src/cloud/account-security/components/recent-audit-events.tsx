/**
 * Recent security events. The Worker currently exposes POST-only audit
 * ingestion, not a user-readable audit-event list, so render the explicit
 * unavailable state without issuing a dead account-audit request.
 */

import {
  SettingsGroup,
  SettingsRow,
  SettingsStack,
} from "../../../components/settings/settings-layout";
import { useCloudT } from "../../shell/CloudI18nProvider";

export function RecentAuditEvents() {
  const t = useCloudT();

  return (
    <SettingsStack data-testid="cloud-recent-audit-events">
      <SettingsGroup
        title={t("cloud.recentAuditEvents.title", {
          defaultValue: "Recent security events",
        })}
        description={t("cloud.recentAuditEvents.subtitle", {
          defaultValue: "Last 50 audit events recorded against your account.",
        })}
      >
        <SettingsRow
          label={t("cloud.recentAuditEvents.notExposed", {
            defaultValue: "Audit log reading is unavailable on this server.",
          })}
        />
      </SettingsGroup>
    </SettingsStack>
  );
}
