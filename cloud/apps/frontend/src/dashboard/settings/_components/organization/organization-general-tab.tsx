/**
 * Organization general tab component displaying organization details and information.
 * Shows organization name, slug, status, balance, and creation date.
 *
 * @param props - Organization general tab configuration
 * @param props.organization - Organization data to display
 */

"use client";

import { BrandCard, CornerBrackets } from "@elizaos/cloud-ui";
import { format } from "date-fns";
import { Calendar } from "lucide-react";
import type { OrganizationDto } from "@/types/cloud-api";

interface OrganizationGeneralTabProps {
  organization: OrganizationDto;
}

export function OrganizationGeneralTab({ organization }: OrganizationGeneralTabProps) {
  return (
    <div className="space-y-4 md:space-y-6">
      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />
        <div className="relative z-10 space-y-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
              <h3 className="text-sm md:text-base font-mono text-[#e1e1e1] uppercase">
                Organization Details
              </h3>
            </div>
            <p className="text-xs md:text-sm font-mono text-[#858585]">
              Basic information about your organization
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-mono font-medium text-white/50 uppercase tracking-wide">
                Organization Name
              </label>
              <p className="mt-1 text-sm font-mono font-semibold text-white">{organization.name}</p>
            </div>
            <div>
              <label className="text-xs font-mono font-medium text-white/50 uppercase tracking-wide">
                Organization Slug
              </label>
              <p className="mt-1 text-sm font-mono text-white">{organization.slug}</p>
            </div>
            <div>
              <label className="text-xs font-mono font-medium text-white/50 uppercase tracking-wide">
                Status
              </label>
              <div className="mt-1">
                <span
                  className={`px-2 py-1 text-xs font-mono font-bold uppercase tracking-wide border ${organization.is_active ? "bg-green-500/20 text-green-400 border-green-500/40" : "bg-rose-500/20 text-rose-400 border-rose-500/40"}`}
                >
                  {organization.is_active ? "Active" : "Inactive"}
                </span>
              </div>
            </div>
            <div>
              <label className="text-xs font-mono font-medium text-white/50 uppercase tracking-wide">
                Created
              </label>
              <p className="mt-1 text-sm font-mono flex items-center gap-1.5 text-white">
                <Calendar className="h-3.5 w-3.5 text-[#FF5800]" />
                {format(new Date(organization.created_at), "MMM d, yyyy")}
              </p>
            </div>
          </div>
        </div>
      </BrandCard>

      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />
        <div className="relative z-10 space-y-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
              <h3 className="text-sm md:text-base font-mono text-[#e1e1e1] uppercase">
                Billing Information
              </h3>
            </div>
            <p className="text-xs md:text-sm font-mono text-[#858585]">
              Credit balance and billing details
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-mono font-medium text-white/50 uppercase tracking-wide">
                Credit Balance
              </label>
              <p className="mt-1 text-xl md:text-2xl font-mono font-bold text-white">
                {organization.credit_balance.toLocaleString()} credits
              </p>
            </div>
            {organization.billing_email && (
              <div>
                <label className="text-xs font-mono font-medium text-white/50 uppercase tracking-wide">
                  Billing Email
                </label>
                <p className="mt-1 text-sm font-mono text-white break-all">
                  {organization.billing_email}
                </p>
              </div>
            )}
          </div>
        </div>
      </BrandCard>
    </div>
  );
}
