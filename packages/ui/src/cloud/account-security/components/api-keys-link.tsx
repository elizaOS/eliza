/**
 * Link card to the API keys surface. Ported from
 * `@elizaos/cloud-frontend/src/dashboard/security/_components/api-keys-link.tsx`.
 * `/dashboard/api-keys` is carried by the shell's compat-redirect map to the
 * canonical API-keys home (`/settings#api-keys`).
 */

import { KeyRound } from "lucide-react";
import { Link } from "react-router-dom";
import { BrandButton, BrandCard, CornerBrackets } from "../../../cloud-ui";
import { useCloudT } from "../../shell/CloudI18nProvider";

export function ApiKeysLink() {
  const t = useCloudT();
  return (
    <BrandCard className="relative">
      <CornerBrackets size="sm" className="opacity-50" />
      <div className="relative z-10 flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="rounded-sm border border-[var(--brand-orange)]/40 bg-[var(--brand-orange)]/15 p-2">
            <KeyRound className="h-4 w-4 text-[var(--brand-orange)]" />
          </div>
          <div className="space-y-0.5">
            <p className="text-sm font-medium text-white">
              {t("cloud.apiKeysLink.title", { defaultValue: "API keys" })}
            </p>
            <p className="text-xs text-white/60">
              {t("cloud.apiKeysLink.description", {
                defaultValue:
                  "Manage long-lived keys, their scopes, and per-key audit history.",
              })}
            </p>
          </div>
        </div>
        <Link to="/dashboard/api-keys">
          <BrandButton variant="outline" size="sm">
            {t("cloud.apiKeysLink.manageKeys", { defaultValue: "Manage keys" })}
          </BrandButton>
        </Link>
      </div>
    </BrandCard>
  );
}
