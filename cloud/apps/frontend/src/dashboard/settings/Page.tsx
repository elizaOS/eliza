import { DashboardErrorState, DashboardLoadingState } from "@elizaos/cloud-ui";
import { Helmet } from "react-helmet-async";
import { useUserProfile } from "../../lib/data/user";
import { SettingsPageClient } from "./_components/settings-page-client";

/** /dashboard/settings */
export default function SettingsPage() {
  const { user, isLoading, isReady, isAuthenticated, isError, error } = useUserProfile();

  return (
    <>
      <Helmet>
        <title>Settings</title>
        <meta name="description" content="Manage your account preferences, profile, and settings" />
      </Helmet>
      {!isReady || (isAuthenticated && isLoading) ? (
        <DashboardLoadingState label="Loading settings" />
      ) : isError ? (
        <DashboardErrorState message={(error as Error)?.message ?? "Failed to load settings"} />
      ) : !user ? (
        <DashboardLoadingState label="Loading settings" />
      ) : (
        <SettingsPageClient user={user as never} />
      )}
    </>
  );
}
