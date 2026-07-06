/**
 * Self-loading Organization settings section.
 *
 * Zero-arg component (the contract for `registerSettingsSection`): it resolves
 * the current user + organization itself via {@link useOrganizationUser} and
 * renders the {@link OrganizationTab}. This is what the settings-section
 * agent registers into the settings-section registry, and what the cloud route
 * (`OrganizationPage`) mounts.
 *
 * It does not own its own providers — it assumes it renders inside the cloud
 * shell, which supplies the React-Query client and {@link CloudI18nProvider}.
 */

import { Loader2 } from "lucide-react";
import { ApiError } from "../lib/api-client";
import { useOrganizationUser } from "./data/use-organization";
import { OrganizationTab } from "./organization-tab";

export function OrganizationSection() {
  const { data: user, isLoading, error } = useOrganizationUser();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-muted" />
      </div>
    );
  }

  if (error || !user) {
    const message =
      error instanceof ApiError && error.status === 401
        ? "Sign in to Eliza Cloud to manage your organization."
        : "Unable to load your organization.";
    return (
      <div className="bg-surface border border-brand-surface p-8 text-center">
        <p className="text-sm font-mono text-muted">{message}</p>
      </div>
    );
  }

  return <OrganizationTab user={user} />;
}

export default OrganizationSection;
