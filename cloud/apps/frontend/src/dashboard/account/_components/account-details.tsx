/**
 * Account details component displaying user account information and status.
 * Shows account ID, email verification, wallet address, and important dates.
 *
 * @param props - Account details configuration
 * @param props.user - User data with organization information
 */

"use client";

import { BrandCard, CornerBrackets } from "@elizaos/cloud-ui";
import { Calendar, CheckCircle2, Info, Wallet, XCircle } from "lucide-react";
import type { UserWithOrganizationDto } from "@/types/cloud-api";

interface AccountDetailsProps {
  user: UserWithOrganizationDto;
}

export function AccountDetails({ user }: AccountDetailsProps) {
  const formatDate = (date: Date | string | null) => {
    if (!date) return "N/A";
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
            <Info className="h-5 w-5 text-[#FF5800]" />
            <h3 className="text-lg font-bold text-white">Account Details</h3>
          </div>
          <p className="text-sm text-white/60">View your account status and important dates</p>
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <p className="text-xs text-white/50 uppercase tracking-wide">Account ID</p>
              <p className="font-mono text-xs text-white/70">{user.id}</p>
            </div>

            {user.email && (
              <div className="space-y-1">
                <p className="text-xs text-white/50 uppercase tracking-wide">Email Verification</p>
                <div className="flex items-center gap-2">
                  {user.email_verified ? (
                    <>
                      <CheckCircle2 className="h-4 w-4 text-green-400" />
                      <span className="rounded-none border border-green-500/40 bg-green-500/10 px-2 py-0.5 text-xs text-green-400">
                        Verified
                      </span>
                    </>
                  ) : (
                    <>
                      <XCircle className="h-4 w-4 text-amber-400" />
                      <span className="rounded-none border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-300">
                        Not Verified
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
                  Wallet Status
                </p>
                <div className="flex items-center gap-2">
                  {user.wallet_verified ? (
                    <>
                      <CheckCircle2 className="h-4 w-4 text-green-400" />
                      <span className="rounded-none border border-green-500/40 bg-green-500/10 px-2 py-0.5 text-xs text-green-400">
                        Verified
                      </span>
                    </>
                  ) : (
                    <>
                      <XCircle className="h-4 w-4 text-amber-400" />
                      <span className="rounded-none border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-300">
                        Not Verified
                      </span>
                    </>
                  )}
                </div>
              </div>
            )}

            <div className="space-y-1">
              <p className="text-xs text-white/50 uppercase tracking-wide">Account Status</p>
              <span
                className={`rounded-none px-2 py-1 text-xs font-bold uppercase tracking-wide border ${user.is_active ? "bg-green-500/20 text-green-400 border-green-500/40" : "bg-rose-500/20 text-rose-400 border-rose-500/40"}`}
              >
                {user.is_active ? "Active" : "Inactive"}
              </span>
            </div>

            <div className="space-y-1">
              <p className="text-xs text-white/50 uppercase tracking-wide">Role</p>
              <span className="rounded-none bg-white/10 px-2 py-1 text-xs text-white capitalize">
                {user.role}
              </span>
            </div>

            <div className="space-y-1">
              <p className="text-xs text-white/50 uppercase tracking-wide flex items-center gap-2">
                <Calendar className="h-4 w-4 text-[#FF5800]" />
                Account Created
              </p>
              <p className="text-sm text-white">{formatDate(user.created_at)}</p>
            </div>

            <div className="space-y-1">
              <p className="text-xs text-white/50 uppercase tracking-wide flex items-center gap-2">
                <Calendar className="h-4 w-4 text-[#FF5800]" />
                Last Updated
              </p>
              <p className="text-sm text-white">{formatDate(user.updated_at)}</p>
            </div>
          </div>

          <div className="pt-4 border-t border-white/10 space-y-3">
            {user.wallet_address && (
              <div className="space-y-1">
                <p className="text-xs text-white/50 uppercase tracking-wide flex items-center gap-2">
                  <Wallet className="h-4 w-4 text-[#FF5800]" />
                  Wallet Address
                </p>
                <p className="font-mono text-xs break-all text-white">{user.wallet_address}</p>
                {user.wallet_chain_type && (
                  <span className="rounded-none bg-white/10 px-2 py-0.5 text-xs text-white capitalize">
                    {user.wallet_chain_type}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </BrandCard>
  );
}
