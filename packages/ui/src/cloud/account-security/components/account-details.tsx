/**
 * Account details: account id, email/wallet verification, status, role, and
 * important dates.
 */

import { Calendar, CheckCircle2, Info, Wallet, XCircle } from "lucide-react";
import { BrandCard, CornerBrackets } from "../../../cloud-ui";
import { useCloudT } from "../../shell/CloudI18nProvider";
import type { UserProfile } from "../data/user";

interface AccountDetailsProps {
  user: UserProfile;
}

export function AccountDetails({ user }: AccountDetailsProps) {
  const t = useCloudT();
  const formatDate = (date: Date | string | null) => {
    if (!date)
      return t("cloud.accountDetails.notAvailable", { defaultValue: "N/A" });
    return new Date(date).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <BrandCard className="relative">
      <CornerBrackets size="sm" className="opacity-50" />

      <div className="relative z-10 space-y-6">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Info className="h-5 w-5 text-[var(--brand-orange)]" />
            <h3 className="text-lg font-bold text-white">
              {t("cloud.accountDetails.title", {
                defaultValue: "Account Details",
              })}
            </h3>
          </div>
          <p className="text-sm text-white/60">
            {t("cloud.accountDetails.subtitle", {
              defaultValue: "View your account status and important dates",
            })}
          </p>
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <p className="text-xs text-white/50 uppercase tracking-wide">
                {t("cloud.accountDetails.accountId", {
                  defaultValue: "Account ID",
                })}
              </p>
              <p className="font-mono text-xs text-white/70">{user.id}</p>
            </div>

            {user.email && (
              <div className="space-y-1">
                <p className="text-xs text-white/50 uppercase tracking-wide">
                  {t("cloud.accountDetails.emailVerification", {
                    defaultValue: "Email Verification",
                  })}
                </p>
                <div className="flex items-center gap-2">
                  {user.email_verified ? (
                    <>
                      <CheckCircle2 className="h-4 w-4 text-green-400" />
                      <span className="rounded-sm border border-green-500/40 bg-green-500/10 px-2 py-0.5 text-xs text-green-400">
                        {t("cloud.accountDetails.verified", {
                          defaultValue: "Verified",
                        })}
                      </span>
                    </>
                  ) : (
                    <>
                      <XCircle className="h-4 w-4 text-orange-400" />
                      <span className="rounded-sm border border-orange-500/40 bg-orange-500/10 px-2 py-0.5 text-xs text-orange-300">
                        {t("cloud.accountDetails.notVerified", {
                          defaultValue: "Not Verified",
                        })}
                      </span>
                    </>
                  )}
                </div>
              </div>
            )}

            {user.wallet_address && (
              <div className="space-y-1">
                <p className="text-xs text-white/50 uppercase tracking-wide flex items-center gap-2">
                  <Wallet className="h-4 w-4" />
                  {t("cloud.accountDetails.walletStatus", {
                    defaultValue: "Wallet Status",
                  })}
                </p>
                <div className="flex items-center gap-2">
                  {user.wallet_verified ? (
                    <>
                      <CheckCircle2 className="h-4 w-4 text-green-400" />
                      <span className="rounded-sm border border-green-500/40 bg-green-500/10 px-2 py-0.5 text-xs text-green-400">
                        {t("cloud.accountDetails.verified", {
                          defaultValue: "Verified",
                        })}
                      </span>
                    </>
                  ) : (
                    <>
                      <XCircle className="h-4 w-4 text-orange-400" />
                      <span className="rounded-sm border border-orange-500/40 bg-orange-500/10 px-2 py-0.5 text-xs text-orange-300">
                        {t("cloud.accountDetails.notVerified", {
                          defaultValue: "Not Verified",
                        })}
                      </span>
                    </>
                  )}
                </div>
              </div>
            )}

            <div className="space-y-1">
              <p className="text-xs text-white/50 uppercase tracking-wide">
                {t("cloud.accountDetails.accountStatus", {
                  defaultValue: "Account Status",
                })}
              </p>
              <span
                className={`rounded-sm px-2 py-1 text-xs font-bold uppercase tracking-wide border ${user.is_active ? "bg-green-500/20 text-green-400 border-green-500/40" : "bg-red-500/20 text-red-400 border-red-500/40"}`}
              >
                {user.is_active
                  ? t("cloud.accountDetails.active", { defaultValue: "Active" })
                  : t("cloud.accountDetails.inactive", {
                      defaultValue: "Inactive",
                    })}
              </span>
            </div>

            <div className="space-y-1">
              <p className="text-xs text-white/50 uppercase tracking-wide">
                {t("cloud.accountDetails.role", { defaultValue: "Role" })}
              </p>
              <span className="rounded-sm bg-white/10 px-2 py-1 text-xs text-white capitalize">
                {user.role}
              </span>
            </div>

            <div className="space-y-1">
              <p className="text-xs text-white/50 uppercase tracking-wide flex items-center gap-2">
                <Calendar className="h-4 w-4 text-[var(--brand-orange)]" />
                {t("cloud.accountDetails.accountCreated", {
                  defaultValue: "Account Created",
                })}
              </p>
              <p className="text-sm text-white">
                {formatDate(user.created_at)}
              </p>
            </div>

            <div className="space-y-1">
              <p className="text-xs text-white/50 uppercase tracking-wide flex items-center gap-2">
                <Calendar className="h-4 w-4 text-[var(--brand-orange)]" />
                {t("cloud.accountDetails.lastUpdated", {
                  defaultValue: "Last Updated",
                })}
              </p>
              <p className="text-sm text-white">
                {formatDate(user.updated_at)}
              </p>
            </div>
          </div>

          {user.wallet_address && (
            <div className="pt-4 border-t border-white/10 space-y-3">
              <div className="space-y-1">
                <p className="text-xs text-white/50 uppercase tracking-wide flex items-center gap-2">
                  <Wallet className="h-4 w-4 text-[var(--brand-orange)]" />
                  {t("cloud.accountDetails.walletAddress", {
                    defaultValue: "Wallet Address",
                  })}
                </p>
                <p className="font-mono text-xs break-all text-white">
                  {user.wallet_address}
                </p>
                {user.wallet_chain_type && (
                  <span className="rounded-sm bg-white/10 px-2 py-0.5 text-xs text-white capitalize">
                    {user.wallet_chain_type}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </BrandCard>
  );
}
