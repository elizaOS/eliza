/**
 * Account cloud route entry.
 *
 * Lifted from `@elizaos/cloud-frontend/src/dashboard/account/Page.tsx` +
 * `_components/account-page-client.tsx` and the `src/lib/data/user.ts` hook.
 * Gates on the Steward session via {@link useUserProfile}, renders the account
 * body, and uses the cloud-ui dashboard placeholders for loading / error. Page
 * title is set via {@link useDocumentTitle} (no Helmet).
 *
 * `AccountSurface` is the embeddable body (used by the Wave-3 settings section);
 * the default export wraps it in a `PageHeaderProvider` for the standalone
 * `/dashboard/account` route (the body calls `useSetPageHeader`).
 */

import {
  DashboardErrorState,
  DashboardLoadingState,
  PageHeaderProvider,
} from "../../cloud-ui";
import { useCloudT } from "../shell/CloudI18nProvider";
import { AccountPageClient } from "./components/account-page-client";
import { useUserProfile } from "./data/user";
import { useDocumentTitle } from "./use-document-title";

/**
 * The account surface. Embeddable: handed to the Wave-3 settings section and
 * wrapped by {@link AccountRoute} for the standalone route. Assumes a
 * `PageHeaderProvider` ancestor (the body sets the page header).
 */
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

/** Default export consumed by the cloud-route registry. */
export default function AccountRoute() {
  return (
    <PageHeaderProvider>
      <AccountSurface />
    </PageHeaderProvider>
  );
}
