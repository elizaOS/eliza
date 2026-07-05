/**
 * Active sessions panel. The Worker does not currently expose session
 * enumeration/revocation, so keep this panel in the explicit unavailable state
 * instead of issuing dead account-session calls on every Security page load.
 */

import { BrandCard, CornerBrackets } from "../../../cloud-ui";
import { useCloudT } from "../../shell/CloudI18nProvider";

export function ActiveSessionsPanel() {
  const t = useCloudT();

  return (
    <BrandCard className="relative">
      <CornerBrackets size="sm" className="opacity-50" />
      <div className="relative z-10 space-y-4">
        <div>
          <h3 className="text-lg font-bold text-white">
            {t("cloud.activeSessions.title", {
              defaultValue: "Active sessions",
            })}
          </h3>
          <p className="text-sm text-white/60">
            {t("cloud.activeSessions.description", {
              defaultValue:
                "Devices and browsers currently signed in to your account.",
            })}
          </p>
        </div>
        <p className="text-sm text-white/50">
          {t("cloud.activeSessions.notAvailable", {
            defaultValue: "Session listing is unavailable on this server.",
          })}
        </p>
      </div>
    </BrandCard>
  );
}
