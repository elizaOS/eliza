import { DashboardErrorState, DashboardLoadingState } from "@elizaos/ui";
import { Helmet } from "react-helmet-async";
import { useT } from "@/providers/I18nProvider";
import { useUserProfile } from "../../lib/data/user";
import { AccountPageClient } from "./_components/account-page-client";

/** /dashboard/account — wraps the existing AccountPageClient. */
export default function AccountPage() {
  const t = useT();
  const { user, isLoading, isReady, isAuthenticated, isError, error } =
    useUserProfile();

  return (
    <>
      <Helmet>
        <title>
          {t("cloud.account.metaTitle", { defaultValue: "Account Settings" })}
        </title>
        <meta
          name="description"
          content={t("cloud.account.metaDescription", {
            defaultValue:
              "Manage your account preferences, profile, and security settings",
          })}
        />
      </Helmet>
      {!isReady || (isAuthenticated && isLoading) ? (
        <DashboardLoadingState
          label={t("cloud.account.loading", {
            defaultValue: "Loading account",
          })}
        />
      ) : isError ? (
        <DashboardErrorState
          message={
            (error as Error)?.message ??
            t("cloud.account.loadError", {
              defaultValue: "Failed to load account",
            })
          }
        />
      ) : !user ? (
        <DashboardLoadingState
          label={t("cloud.account.loading", {
            defaultValue: "Loading account",
          })}
        />
      ) : (
        <AccountPageClient user={user as never} />
      )}
    </>
  );
}
