/**
 * Organization info component displaying organization details and balance.
 * Shows organization name, slug, balance, and creation date.
 *
 * @param props - Organization info configuration
 * @param props.organization - Organization data to display
 */

"use client";

import { BrandCard, CornerBrackets } from "@elizaos/cloud-ui";
import { Building2, Calendar, CreditCard } from "lucide-react";
import type { OrganizationDto } from "@/types/cloud-api";

interface OrganizationInfoProps {
  organization: OrganizationDto;
}

export function OrganizationInfo({ organization }: OrganizationInfoProps) {
  const formatDate = (date: Date | null) => {
    if (!date) return "N/A";
    return new Date(date).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  };

  const formatBalance = (balance: number) => {
    return `$${Number(balance).toFixed(2)}`;
  };

  return (
    <BrandCard className="relative">
      <CornerBrackets size="sm" className="opacity-50" />

      <div className="relative z-10 space-y-6">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Building2 className="h-5 w-5 text-[#FF5800]" />
            <h3 className="text-lg font-bold text-white">Organization</h3>
          </div>
          <p className="text-sm text-white/60">Information about your organization</p>
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <p className="text-xs text-white/50 uppercase tracking-wide">Organization Name</p>
              <p className="font-medium text-white">{organization.name}</p>
            </div>

            <div className="space-y-1">
              <p className="text-xs text-white/50 uppercase tracking-wide">Slug</p>
              <p className="font-mono text-sm text-white">{organization.slug}</p>
            </div>

            <div className="space-y-1">
              <p className="text-xs text-white/50 uppercase tracking-wide flex items-center gap-2">
                <CreditCard className="h-4 w-4 text-[#FF5800]" />
                Balance
              </p>
              <p className="font-semibold text-lg text-white">
                {formatBalance(Number(organization.credit_balance))}
              </p>
            </div>

            <div className="space-y-1">
              <p className="text-xs text-white/50 uppercase tracking-wide">Status</p>
              <span
                className={`rounded-none px-2 py-1 text-xs font-bold uppercase tracking-wide border ${organization.is_active ? "bg-green-500/20 text-green-400 border-green-500/40" : "bg-rose-500/20 text-rose-400 border-rose-500/40"}`}
              >
                {organization.is_active ? "Active" : "Inactive"}
              </span>
            </div>

            <div className="space-y-1">
              <p className="text-xs text-white/50 uppercase tracking-wide flex items-center gap-2">
                <Calendar className="h-4 w-4 text-[#FF5800]" />
                Member Since
              </p>
              <p className="text-sm text-white">{formatDate(organization.created_at)}</p>
            </div>
          </div>

          {organization.billing_email && (
            <div className="pt-4 border-t border-white/10 space-y-1">
              <p className="text-xs text-white/50 uppercase tracking-wide">Billing Email</p>
              <p className="text-sm text-white">{organization.billing_email}</p>
            </div>
          )}
        </div>
      </div>
    </BrandCard>
  );
}
