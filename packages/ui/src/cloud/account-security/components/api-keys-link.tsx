/**
 * Link card from the Security section to the API-keys settings section
 * (`/settings#cloud-api-keys`).
 */

import { KeyRound } from "lucide-react";
import { BrandButton, BrandCard, CornerBrackets } from "../../../cloud-ui";
import { useCloudT } from "../../shell/CloudI18nProvider";

export function ApiKeysLink() {
  const t = useCloudT();
  return (
    <BrandCard className="relative">
      <CornerBrackets size="sm" className="opacity-50" />
      <div className="relative z-10 flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="rounded-sm border border-border bg-muted p-2">
            <KeyRound className="h-4 w-4 text-txt-strong" />
          </div>
          <div className="space-y-0.5">
            <p className="text-sm font-medium text-txt-strong">
              {t("cloud.apiKeysLink.title", { defaultValue: "API keys" })}
            </p>
            <p className="text-xs text-muted">
              {t("cloud.apiKeysLink.description", {
                defaultValue:
                  "Manage long-lived keys, their scopes, and per-key audit history.",
              })}
            </p>
          </div>
        </div>
        {/* Plain anchor: an in-settings hash change fires `hashchange`,
            which is what SettingsView listens to for section switches. */}
        <a href="#cloud-api-keys">
          <BrandButton variant="outline" size="sm">
            {t("cloud.apiKeysLink.manageKeys", { defaultValue: "Manage keys" })}
          </BrandButton>
        </a>
      </div>
    </BrandCard>
  );
}
