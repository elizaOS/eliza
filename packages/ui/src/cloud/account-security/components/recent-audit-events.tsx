/**
 * Recent security events. The Worker currently exposes POST-only audit
 * ingestion, not a user-readable audit-event list, so render the explicit
 * unavailable state without issuing a dead account-audit request.
 */

import { BrandCard, CornerBrackets } from "../../../cloud-ui";
import { useCloudT } from "../../shell/CloudI18nProvider";

export function RecentAuditEvents() {
  const t = useCloudT();

  return (
    <BrandCard className="relative">
      <CornerBrackets size="sm" className="opacity-50" />
      <div className="relative z-10 space-y-3">
        <div>
          <h3 className="text-lg font-bold text-white">
            {t("cloud.recentAuditEvents.title", {
              defaultValue: "Recent security events",
            })}
          </h3>
          <p className="text-sm text-white/60">
            {t("cloud.recentAuditEvents.subtitle", {
              defaultValue:
                "Last 50 audit events recorded against your account.",
            })}
          </p>
        </div>
        <p className="text-sm text-white/50">
          {t("cloud.recentAuditEvents.notExposed", {
            defaultValue: "Audit log reading is unavailable on this server.",
          })}
        </p>
      </div>
    </BrandCard>
  );
}
