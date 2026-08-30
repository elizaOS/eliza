/**
 * Renders the registered Cloud management route that owns the current
 * `/cloud/*` URL inside the normal Eliza app-shell page. Route parameters,
 * session authentication, loading, and error boundaries remain identical to
 * the former standalone console mount. Account access follows the Steward
 * session rather than the currently selected agent runtime.
 */

import type { PageLayoutManifest } from "@elizaos/core";
import { type ComponentType, Suspense } from "react";
import {
  matchPath,
  Navigate,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { DashboardLoadingState } from "../../cloud-ui/components/dashboard/route-placeholders";
import {
  EnsurePageHeaderProvider,
  usePageHeader,
} from "../../cloud-ui/components/layout";
import { ViewHeader } from "../../components/shared/ViewHeader";
import { PageFrame } from "../../layouts";
import { useSessionAuth } from "../lib/use-session-auth";
import { CloudAccountMenu } from "./CloudAccountMenu";
import { CloudRouteErrorBoundary } from "./CloudRouteErrorBoundary";
import {
  type CloudRouteDef,
  getCloudRouteGate,
  listCloudRoutes,
} from "./cloud-route-registry";

const DEFAULT_MANAGED_CLOUD_LAYOUT: PageLayoutManifest = Object.freeze({
  kind: "content",
  topology: "framed",
  width: "standard",
  scroll: "shell",
  gutter: "standard",
});

function managedRouteForPath(pathname: string): CloudRouteDef | null {
  return (
    listCloudRoutes().find(
      (route) =>
        (route.group === "cloud" || route.group === "admin") &&
        matchPath({ path: `/${route.path}`, end: true }, pathname),
    ) ?? null
  );
}

function ManagedCloudUnavailable({ message }: { message: string }) {
  return (
    <div
      className="flex min-h-48 items-center justify-center px-6 text-center text-sm text-muted"
      role="alert"
    >
      {message}
    </div>
  );
}

function renderManagedRoute(route: CloudRouteDef): React.ReactNode {
  const RouteComponent = route.element as ComponentType<unknown>;
  const body = (
    <CloudRouteErrorBoundary routePath={route.path}>
      <Suspense
        fallback={
          <div className="min-h-48" data-testid="managed-cloud-route-loading">
            <DashboardLoadingState label="Loading Cloud dashboard page" />
          </div>
        }
      >
        <RouteComponent />
      </Suspense>
    </CloudRouteErrorBoundary>
  );
  if (!route.gate) return body;
  const Gate = getCloudRouteGate(route.gate);
  return Gate ? (
    <Gate>{body}</Gate>
  ) : (
    <ManagedCloudUnavailable message="This area could not be authorized." />
  );
}

function ManagedCloudRouteFrame({
  route,
  email,
}: {
  route: CloudRouteDef;
  email: string | null;
}): React.JSX.Element {
  const { pageInfo } = usePageHeader();
  const location = useLocation();
  const navigate = useNavigate();
  const isCloudOverview = location.pathname === "/cloud";
  const layout = route.surface?.layout ?? DEFAULT_MANAGED_CLOUD_LAYOUT;
  return (
    <div className="theme-cloud flex min-h-0 min-w-0 flex-1 flex-col bg-bg text-txt">
      <ViewHeader
        title={pageInfo?.title ?? "Cloud"}
        onBack={isCloudOverview ? undefined : () => navigate("/cloud")}
        backLabel={
          isCloudOverview ? "Back to launcher" : "Back to Cloud overview"
        }
        right={
          <div className="flex items-center gap-2">
            {pageInfo?.actions}
            <CloudAccountMenu email={email} />
          </div>
        }
        className="border-b border-border"
      />
      {pageInfo?.description ? (
        <p className="sr-only">{pageInfo.description}</p>
      ) : null}
      <PageFrame
        layout={layout}
        data-shell-scroll-region={
          layout.scroll === "shell" ? "true" : undefined
        }
      >
        {renderManagedRoute(route)}
      </PageFrame>
    </div>
  );
}

export function ManagedCloudPage(): React.JSX.Element {
  const location = useLocation();
  const session = useSessionAuth();
  const route = managedRouteForPath(location.pathname);

  if (!session.ready) {
    return (
      <div className="theme-cloud min-h-48 p-4 text-txt md:p-6">
        <DashboardLoadingState label="Loading Cloud dashboard" />
      </div>
    );
  }
  if (!session.authenticated) {
    const returnTo = encodeURIComponent(
      `${location.pathname}${location.search}${location.hash}`,
    );
    return <Navigate to={`/login?returnTo=${returnTo}`} replace />;
  }
  if (!route) {
    return (
      <ManagedCloudUnavailable message="Cloud management page not found." />
    );
  }

  return (
    <EnsurePageHeaderProvider>
      <ManagedCloudRouteFrame
        route={route}
        email={session.user?.email ?? null}
      />
    </EnsurePageHeaderProvider>
  );
}

export default ManagedCloudPage;
