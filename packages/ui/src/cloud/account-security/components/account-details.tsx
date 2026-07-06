/**
 * Read-only account details: account id, email + verification, and join date.
 */

import { CheckCircle2, Info, XCircle } from "lucide-react";
import { BrandCard, CornerBrackets } from "../../../cloud-ui";
import { useCloudT } from "../../shell/CloudI18nProvider";
import type { UserProfile } from "../data/user";

interface AccountDetailsProps {
  user: UserProfile;
}

export function AccountDetails({ user }: AccountDetailsProps) {
  const t = useCloudT();
  const created = user.created_at
    ? new Date(user.created_at).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : null;

  return (
    <BrandCard className="relative">
      <CornerBrackets size="sm" className="opacity-50" />

      <div className="relative z-10 space-y-6">
        <div className="flex items-center gap-2">
          <Info className="h-5 w-5 text-muted" />
          <h3 className="text-lg font-bold text-txt-strong">
            {t("cloud.accountDetails.title", {
              defaultValue: "Account details",
            })}
          </h3>
        </div>

        <div className="space-y-4">
          <div className="space-y-1">
            <p className="text-xs text-muted uppercase tracking-wide">
              {t("cloud.accountDetails.accountId", {
                defaultValue: "Account ID",
              })}
            </p>
            <p className="font-mono text-xs text-txt">{user.id}</p>
          </div>

          {user.email && (
            <div className="space-y-1">
              <p className="text-xs text-muted uppercase tracking-wide">
                {t("cloud.accountDetails.email", { defaultValue: "Email" })}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-txt-strong">{user.email}</span>
                {user.email_verified ? (
                  <span className="inline-flex items-center gap-1 rounded-sm border border-green-500/40 bg-green-500/10 px-2 py-0.5 text-xs text-green-400">
                    <CheckCircle2 className="h-3 w-3" />
                    {t("cloud.accountDetails.verified", {
                      defaultValue: "Verified",
                    })}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-sm border border-border bg-muted px-2 py-0.5 text-xs text-txt-strong">
                    <XCircle className="h-3 w-3" />
                    {t("cloud.accountDetails.notVerified", {
                      defaultValue: "Unverified",
                    })}
                  </span>
                )}
              </div>
            </div>
          )}

          {created && (
            <div className="space-y-1">
              <p className="text-xs text-muted uppercase tracking-wide">
                {t("cloud.accountDetails.accountCreated", {
                  defaultValue: "Member since",
                })}
              </p>
              <p className="text-sm text-txt-strong">{created}</p>
            </div>
          )}
        </div>
      </div>
    </BrandCard>
  );
}
