/**
 * Organization general tab — read-only organization details + billing summary.
 * Intentionally read-only: Eliza Cloud has no organization-rename flow, so this
 * surface displays name/slug/status/balance but never edits them. Labelled
 * status fields compose SettingsStack / SettingsGroup / SettingsRow.
 */

import { format } from "date-fns";
import { Calendar } from "lucide-react";
import {
  SettingsGroup,
  SettingsRow,
  SettingsStack,
} from "../../components/settings/settings-layout";
import { StatusBadge } from "../../components/ui/status-badge";
import type { OrganizationDto } from "./data/cloud-org-types";

interface OrganizationGeneralTabProps {
  organization: OrganizationDto;
}

export function OrganizationGeneralTab({
  organization,
}: OrganizationGeneralTabProps) {
  return (
    <SettingsStack data-testid="cloud-organization-general">
      <SettingsGroup
        title="Organization details"
        description="Basic information about your organization"
      >
        <SettingsRow
          label="Organization name"
          description={
            <span className="break-words font-medium text-txt-strong">
              {organization.name}
            </span>
          }
        />
        <SettingsRow
          label="Organization slug"
          description={
            <span className="break-all font-mono text-txt-strong">
              {organization.slug}
            </span>
          }
        />
        <SettingsRow
          label="Status"
          control={
            <StatusBadge
              withDot
              variant={organization.is_active ? "success" : "danger"}
              label={organization.is_active ? "Active" : "Inactive"}
            />
          }
        />
        <SettingsRow
          icon={Calendar}
          label="Created"
          description={
            <span className="text-txt-strong">
              {format(new Date(organization.created_at), "MMM d, yyyy")}
            </span>
          }
        />
      </SettingsGroup>

      <SettingsGroup
        title="Billing information"
        description="Credit balance and billing details"
      >
        <SettingsRow
          label="Credit balance"
          description={
            <span className="tabular-nums text-txt-strong">
              {Number(organization.credit_balance).toLocaleString()} credits
            </span>
          }
        />
        {organization.billing_email ? (
          <SettingsRow
            label="Billing email"
            description={
              <span className="break-all font-mono text-txt-strong">
                {organization.billing_email}
              </span>
            }
          />
        ) : null}
      </SettingsGroup>
    </SettingsStack>
  );
}
