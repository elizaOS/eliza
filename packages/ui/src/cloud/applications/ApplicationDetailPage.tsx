/**
 * /dashboard/apps/:id — single Application detail (8 tabs). The app shell owns
 * the document head; auth gating uses `useSessionAuth()`.
 */

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
import { DashboardPageContainer } from "../../cloud-ui/components/layout";
import { useSessionAuth } from "../lib/use-session-auth";
import { useCloudT } from "../shell/CloudI18nProvider";
import { AppDetailsTabs } from "./components/app-details-tabs";
import { AppPageWrapper } from "./components/single-app-page-wrapper";
import { useApp } from "./lib/apps";
import { consumeOneTimeAppApiKey } from "./lib/one-time-app-api-key";
import { isValidUUID } from "./lib/utils";

/** /dashboard/apps/:id */
export default function ApplicationDetailPage() {
  const t = useCloudT();
  const { id } = useParams<{ id: string }>();
  const session = useSessionAuth();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const legacyQueryApiKey = searchParams.get("showApiKey") ?? undefined;
  const [showApiKey, setShowApiKey] = useState<string | undefined>();

  const validId = id && isValidUUID(id) ? id : undefined;
  const { data: app, isLoading, isError, error } = useApp(validId);

  useEffect(() => {
    if (!validId) return;
    const apiKey = consumeOneTimeAppApiKey(validId);
    if (apiKey) {
      setShowApiKey(apiKey);
    }
  }, [validId]);

  useEffect(() => {
    if (!legacyQueryApiKey) return;
    setShowApiKey(legacyQueryApiKey);
    const params = new URLSearchParams(location.search);
    params.delete("showApiKey");
    const search = params.toString();
    navigate(`${location.pathname}${search ? `?${search}` : ""}`, {
      preventScrollReset: true,
      replace: true,
    });
  }, [legacyQueryApiKey, location.pathname, location.search, navigate]);

  if (id && !isValidUUID(id)) {
    return <Navigate to="/dashboard/apps" replace />;
  }

  if (!session.ready || isLoading) {
    return (
      <DashboardLoadingState
        label={t("cloud.apps.detail.loading", {
          defaultValue: "Loading app",
        })}
      />
    );
  }

  if (isError) {
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
  }

  if (!app) {
    return <Navigate to="/dashboard/apps" replace />;
  }

  return (
    <AppPageWrapper appName={app.name}>
      <DashboardPageContainer className="space-y-3 sm:space-y-6">
        <AppDetailsTabs app={app} showApiKey={showApiKey} />
      </DashboardPageContainer>
    </AppPageWrapper>
  );
}
