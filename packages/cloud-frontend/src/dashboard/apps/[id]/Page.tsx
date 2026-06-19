import {
  DashboardErrorState,
  DashboardLoadingState,
  DashboardPageContainer,
} from "@elizaos/ui";
import { useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";
import {
  Navigate,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { isValidUUID } from "@/lib/utils";
import { useT } from "@/providers/I18nProvider";
import { useRequireAuth } from "../../../lib/auth-hooks";
import { useApp } from "../../../lib/data/apps";
import { AppDetailsTabs } from "../_components/app-details-tabs";
import { consumeOneTimeAppApiKey } from "../_components/one-time-app-api-key";
import { AppPageWrapper } from "../_components/single-app-page-wrapper";

/** /dashboard/apps/:id */
export default function AppDetailsPage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const session = useRequireAuth();
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

  const title = app
    ? t("cloud.apps.detail.metaTitle", {
        defaultValue: "{{name}} | Eliza Cloud",
        name: app.name,
      })
    : t("cloud.apps.detail.metaTitleFallback", { defaultValue: "App" });
  const description =
    app?.description ||
    (app
      ? t("cloud.apps.detail.metaDescription", {
          defaultValue: "Manage {{name}} app settings and analytics",
          name: app.name,
        })
      : "");

  return (
    <>
      <Helmet>
        <title>{title}</title>
        {description && <meta name="description" content={description} />}
        <meta name="robots" content="noindex,nofollow" />
      </Helmet>
      {!session.ready || isLoading ? (
        <DashboardLoadingState
          label={t("cloud.apps.detail.loading", {
            defaultValue: "Loading app",
          })}
        />
      ) : isError ? (
        <DashboardErrorState
          message={
            error instanceof Error
              ? error.message
              : t("cloud.apps.detail.errorFailedLoad", {
                  defaultValue: "Failed to load app",
                })
          }
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
