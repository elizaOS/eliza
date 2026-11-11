/** App detail keeps one scoped deletion owner across metadata refetches. */
import type { QueryKey } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  Navigate,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  DashboardErrorState,
  DashboardLoadingState,
} from "../../cloud-ui/components/dashboard/route-placeholders";
import { DashboardPageContainer } from "../../cloud-ui/components/layout/dashboard-page";
import { authenticatedQueryKey } from "../lib/auth-query";
import { useSessionAuth } from "../lib/use-session-auth";
import { useOrganizationUser } from "../organization/data/use-organization";
import { useCloudT } from "../shell/CloudI18nProvider";
import { AppDetailsTabs } from "./components/app-details-tabs";
import { AppPageWrapper } from "./components/single-app-page-wrapper";
import { APPS_QUERY_KEY, type App, useApp } from "./lib/apps";
import { consumeOneTimeAppApiKey } from "./lib/one-time-app-api-key";
import { isValidUUID } from "./lib/utils";

/** /cloud/apps/:id */
export default function ApplicationDetailPage() {
  const t = useCloudT();
  const { id } = useParams<{ id: string }>();
  const session = useSessionAuth();
  const organization = useOrganizationUser();
  const validId = id && isValidUUID(id) ? id : undefined;
  const result = useApp(validId);
  const userId = session.user?.id ?? null;
  const organizationId = organization.data?.organization_id ?? null;

  if (id && !validId) return <Navigate to="/cloud/apps" replace />;
  if (!session.ready || organization.isLoading) {
    return (
      <DashboardLoadingState
        label={t("cloud.apps.detail.loading", { defaultValue: "Loading app" })}
      />
    );
  }
  if (
    !session.authenticated ||
    !organization.data ||
    organization.isError ||
    organization.data.id !== userId ||
    (result.data && result.data.organization_id !== organizationId)
  ) {
    return (
      <DashboardErrorState
        message={t("cloud.apps.detail.errorFailedLoad", {
          defaultValue: "Failed to load app",
        })}
      />
    );
  }
  if (!validId) return <Navigate to="/cloud/apps" replace />;
  return (
    <ApplicationDetailOwner
      key={`${userId}:${organizationId}:${validId}`}
      id={validId}
      currentApp={result.data}
      isLoading={result.isLoading}
      isError={result.isError}
      error={result.error}
      appsQueryKey={authenticatedQueryKey(APPS_QUERY_KEY, {
        enabled: true,
        userId,
      })}
    />
  );
}

/** Metadata may disappear before cleanup completes; only this admitted scope retains it. */
function ApplicationDetailOwner({
  id,
  currentApp,
  isLoading,
  isError,
  error,
  appsQueryKey,
}: {
  id: string;
  currentApp: App | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  appsQueryKey: QueryKey;
}) {
  const t = useCloudT();
  const [admittedApp, setAdmittedApp] = useState<App | null>(null);
  const app = admittedApp ?? currentApp;
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const queryApiKey = searchParams.get("showApiKey") ?? undefined;
  const [showApiKey, setShowApiKey] = useState<string | undefined>();
  useEffect(() => {
    const apiKey = consumeOneTimeAppApiKey(id);
    if (apiKey) setShowApiKey(apiKey);
  }, [id]);
  useEffect(() => {
    if (!queryApiKey) return;
    const params = new URLSearchParams(location.search);
    params.delete("showApiKey");
    const search = params.toString();
    navigate(`${location.pathname}${search ? `?${search}` : ""}`, {
      preventScrollReset: true,
      replace: true,
    });
  }, [queryApiKey, location.pathname, location.search, navigate]);

  if (!admittedApp && isLoading)
    return (
      <DashboardLoadingState
        label={t("cloud.apps.detail.loading", { defaultValue: "Loading app" })}
      />
    );
  if (!admittedApp && isError)
    return (
      <DashboardErrorState
        message={
          error instanceof Error
            ? error.message
            : t("cloud.apps.detail.errorFailedLoad", {
                defaultValue: "Failed to load app",
              })
        }
      />
    );
  if (!app) return <Navigate to="/cloud/apps" replace />;
  return (
    <AppPageWrapper appName={app.name}>
      <DashboardPageContainer className="space-y-3 sm:space-y-6">
        <AppDetailsTabs
          app={app}
          showApiKey={showApiKey}
          appsQueryKey={appsQueryKey}
          deleting={admittedApp !== null}
          onDeletingChange={(pending) => setAdmittedApp(pending ? app : null)}
        />
      </DashboardPageContainer>
    </AppPageWrapper>
  );
}
