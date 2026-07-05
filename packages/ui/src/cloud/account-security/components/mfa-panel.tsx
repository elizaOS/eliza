/**
 * Two-factor authentication status panel. The Worker does not currently expose
 * an MFA status route, so keep the panel in the explicit unavailable state
 * instead of firing a dead request on Security page load.
 */

import { Lock } from "lucide-react";
import { BrandCard, CornerBrackets } from "../../../cloud-ui";
import { useCloudT } from "../../shell/CloudI18nProvider";

export function MfaPanel() {
  const t = useCloudT();

  return (
    <BrandCard className="relative">
      <CornerBrackets size="sm" className="opacity-50" />
      <div className="relative z-10 space-y-3">
        <div className="flex items-center gap-2">
          <Lock className="h-5 w-5 text-[var(--brand-orange)]" />
          <h3 className="text-lg font-bold text-white">
            {t("cloud.mfaPanel.title", {
              defaultValue: "Two-factor authentication",
            })}
          </h3>
        </div>
        <p className="text-sm text-white/60">
          {t("cloud.mfaPanel.notAvailable", {
            defaultValue: "MFA enrollment is unavailable on this server.",
          })}
        </p>
      </div>
    </BrandCard>
  );
}
