/**
 * Account surface — profile form, organization info, account details. Gates on
 * the Steward session via {@link useUserProfile} and renders the account body.
 * Mounted by the `cloud-account` Settings section (`/settings#cloud-account`).
 */

import { DashboardErrorState, DashboardLoadingState } from "../../cloud-ui";
import { useDocumentTitle } from "../lib/use-document-title";
import { useCloudT } from "../shell/CloudI18nProvider";
import { AccountPageClient } from "./components/account-page-client";
import { useUserProfile } from "./data/user";

/** The account surface. Assumes a `PageHeaderProvider` ancestor. */
export function AccountSurface() {
  const t = useCloudT();
  const { user, isLoading, isReady, isAuthenticated, isError, error } =
    useUserProfile();

  useDocumentTitle(
    t("cloud.account.metaTitle", { defaultValue: "Account Settings" }),
  );

  const loadingLabel = t("cloud.account.loading", {
    defaultValue: "Loading account",
  });

  if (!isReady || (isAuthenticated && isLoading)) {
    return <DashboardLoadingState label={loadingLabel} />;
  }

  if (isError) {
    return (
      <DashboardErrorState
        message={
          error instanceof Error
            ? error.message
            : t("cloud.account.loadError", {
                defaultValue: "Failed to load account",
              })
        }
      />
    );
  }

  if (!user) {
    return <DashboardLoadingState label={loadingLabel} />;
  }

  return <AccountPageClient user={user} />;
}
