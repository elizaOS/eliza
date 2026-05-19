import { DashboardErrorState, DashboardLoadingState } from "@elizaos/ui";
import { Helmet } from "react-helmet-async";
import { useT } from "@/providers/I18nProvider";
import { useUserProfile } from "../../lib/data/user";
import { SettingsPageClient } from "./_components/settings-page-client";

/** /dashboard/settings */
export default function SettingsPage() {
  const t = useT();
  const { user, isLoading, isReady, isAuthenticated, isError, error } =
    useUserProfile();

  return (
    <>
      <Helmet>
        <title>
          {t("cloud.settings.metaTitle", { defaultValue: "Settings" })}
        </title>
        <meta
          name="description"
          content={t("cloud.settings.metaDescription", {
            defaultValue:
              "Manage your account preferences, profile, and settings",
          })}
        />
      </Helmet>
      {!isReady || (isAuthenticated && isLoading) ? (
        <DashboardLoadingState
          label={t("cloud.settings.loading", {
            defaultValue: "Loading settings",
          })}
        />
      ) : isError ? (
        <DashboardErrorState
          message={
            (error as Error)?.message ??
            t("cloud.settings.loadError", {
              defaultValue: "Failed to load settings",
            })
          }
        />
      ) : !user ? (
        <DashboardLoadingState
          label={t("cloud.settings.loading", {
            defaultValue: "Loading settings",
          })}
        />
      ) : (
        <SettingsPageClient user={user as never} />
      )}
    </>
  );
}
