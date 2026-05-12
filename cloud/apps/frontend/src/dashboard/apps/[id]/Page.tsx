import {
  DashboardErrorState,
  DashboardLoadingState,
  DashboardPageContainer,
} from "@elizaos/cloud-ui";
import { Helmet } from "react-helmet-async";
import { Navigate, useParams, useSearchParams } from "react-router-dom";
import { isValidUUID } from "@/lib/utils";
import { useRequireAuth } from "../../../lib/auth-hooks";
import { useApp } from "../../../lib/data/apps";
import { AppDetailsTabs } from "../_components/app-details-tabs";
import { AppPageWrapper } from "../_components/single-app-page-wrapper";

/** /dashboard/apps/:id */
export default function AppDetailsPage() {
  const { id } = useParams<{ id: string }>();
  const session = useRequireAuth();
  const [searchParams] = useSearchParams();
  const showApiKey = searchParams.get("showApiKey") ?? undefined;

  const validId = id && isValidUUID(id) ? id : undefined;
  const { data: app, isLoading, isError, error } = useApp(validId);

  if (id && !isValidUUID(id)) {
    return <Navigate to="/dashboard/apps" replace />;
  }

  const title = app ? `${app.name} | Eliza Cloud` : "App";
  const description =
    app?.description || (app ? `Manage ${app.name} app settings and analytics` : "");

  return (
    <>
      <Helmet>
        <title>{title}</title>
        {description && <meta name="description" content={description} />}
        <meta name="robots" content="noindex,nofollow" />
      </Helmet>
      {!session.ready || isLoading ? (
        <DashboardLoadingState label="Loading app" />
      ) : isError ? (
        <DashboardErrorState
          message={error instanceof Error ? error.message : "Failed to load app"}
        />
      ) : !app ? (
        <Navigate to="/dashboard/apps" replace />
      ) : (
        <AppPageWrapper appName={app.name}>
          <DashboardPageContainer className="space-y-3 sm:space-y-6">
            <AppDetailsTabs app={app} showApiKey={showApiKey} />
          </DashboardPageContainer>
        </AppPageWrapper>
      )}
    </>
  );
}
