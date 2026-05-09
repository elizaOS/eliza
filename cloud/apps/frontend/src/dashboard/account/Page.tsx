import { DashboardErrorState, DashboardLoadingState } from "@elizaos/cloud-ui";
import { Helmet } from "react-helmet-async";
import { useUserProfile } from "../../lib/data/user";
import { AccountPageClient } from "./_components/account-page-client";

/** /dashboard/account — wraps the existing AccountPageClient. */
export default function AccountPage() {
  const { user, isLoading, isReady, isAuthenticated, isError, error } = useUserProfile();

  return (
    <>
      <Helmet>
        <title>Account Settings</title>
        <meta
          name="description"
          content="Manage your account preferences, profile, and security settings"
        />
      </Helmet>
      {!isReady || (isAuthenticated && isLoading) ? (
        <DashboardLoadingState label="Loading account" />
      ) : isError ? (
        <DashboardErrorState message={(error as Error)?.message ?? "Failed to load account"} />
      ) : !user ? (
        <DashboardLoadingState label="Loading account" />
      ) : (
        <AccountPageClient user={user as never} />
      )}
    </>
  );
}
