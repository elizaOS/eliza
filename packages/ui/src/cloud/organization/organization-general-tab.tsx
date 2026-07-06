/**
 * Organization general tab — read-only organization details + billing summary.
 * Intentionally read-only: Eliza Cloud has no organization-rename flow, so this
 * surface displays name/slug/status/balance but never edits them.
 *
 * @param props - Organization general tab configuration
 * @param props.organization - Organization data to display
 */

import { format } from "date-fns";
import { Calendar } from "lucide-react";
import { BrandCard, CornerBrackets } from "../../cloud-ui";
import type { OrganizationDto } from "./data/cloud-org-types";

interface OrganizationGeneralTabProps {
  organization: OrganizationDto;
}

export function OrganizationGeneralTab({
  organization,
}: OrganizationGeneralTabProps) {
  return (
    <div className="space-y-4 md:space-y-6">
      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />
        <div className="relative z-10 space-y-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-2 h-2 rounded-full bg-muted" />
              <h3 className="text-sm md:text-base font-mono text-txt uppercase">
                Organization Details
              </h3>
            </div>
            <p className="text-xs md:text-sm font-mono text-muted">
              Basic information about your organization
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-mono font-medium text-muted uppercase tracking-wide">
                Organization Name
              </p>
              <p className="mt-1 text-sm font-mono font-semibold text-txt-strong">
                {organization.name}
              </p>
            </div>
            <div>
              <p className="text-xs font-mono font-medium text-muted uppercase tracking-wide">
                Organization Slug
              </p>
              <p className="mt-1 text-sm font-mono text-txt-strong">
                {organization.slug}
              </p>
            </div>
            <div>
              <p className="text-xs font-mono font-medium text-muted uppercase tracking-wide">
                Status
              </p>
              <div className="mt-1">
                <span
                  className={`px-2 py-1 text-xs font-mono font-bold uppercase tracking-wide border ${organization.is_active ? "bg-green-500/20 text-green-400 border-green-500/40" : "bg-red-500/20 text-red-400 border-red-500/40"}`}
                >
                  {organization.is_active ? "Active" : "Inactive"}
                </span>
              </div>
            </div>
            <div>
              <p className="text-xs font-mono font-medium text-muted uppercase tracking-wide">
                Created
              </p>
              <p className="mt-1 text-sm font-mono flex items-center gap-1.5 text-txt-strong">
                <Calendar className="h-3.5 w-3.5 text-muted" />
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
              <div className="w-2 h-2 rounded-full bg-muted" />
              <h3 className="text-sm md:text-base font-mono text-txt uppercase">
                Billing Information
              </h3>
            </div>
            <p className="text-xs md:text-sm font-mono text-muted">
              Credit balance and billing details
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-mono font-medium text-muted uppercase tracking-wide">
                Credit Balance
              </p>
              <p className="mt-1 text-xl md:text-2xl font-mono font-bold text-txt-strong">
                {Number(organization.credit_balance).toLocaleString()} credits
              </p>
            </div>
            {organization.billing_email && (
              <div>
                <p className="text-xs font-mono font-medium text-muted uppercase tracking-wide">
                  Billing Email
                </p>
                <p className="mt-1 text-sm font-mono text-txt-strong break-all">
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
