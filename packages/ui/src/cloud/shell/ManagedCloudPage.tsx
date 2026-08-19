/**
 * Renders the registered Cloud management route that owns the current
 * `/cloud/*` URL inside the normal Eliza app-shell page. Route parameters,
 * authorization gates, loading, and error boundaries remain identical to the
 * former standalone console mount.
 */

import { type ComponentType, Suspense } from "react";
import { matchPath, Navigate, useLocation } from "react-router-dom";
import {
  EnsurePageHeaderProvider,
  usePageHeader,
} from "../../cloud-ui/components/layout";
import { ViewHeader } from "../../components/shared/ViewHeader";
import { useAppSelector } from "../../state";
import { useSessionAuth } from "../lib/use-session-auth";
import { isManagedCloudRuntime } from "../managed-cloud-runtime";
import { CloudAccountMenu } from "./CloudAccountMenu";
import { CloudRouteErrorBoundary } from "./CloudRouteErrorBoundary";
import {
  type CloudRouteDef,
  getCloudRouteGate,
  listCloudRoutes,
} from "./cloud-route-registry";

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
    <div className="flex min-h-48 items-center justify-center px-6 text-center text-sm text-muted">
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
          <div
            aria-busy="true"
            className="min-h-48"
            data-testid="managed-cloud-route-loading"
          />
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
  return (
    <div className="theme-cloud flex min-h-0 min-w-0 flex-1 flex-col bg-bg text-txt">
      <ViewHeader
        title={pageInfo?.title ?? "Cloud"}
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
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto p-4 md:p-6">
        {renderManagedRoute(route)}
      </div>
    </div>
  );
}

export function ManagedCloudPage(): React.JSX.Element {
  const location = useLocation();
  const session = useSessionAuth();
  const runtimeTarget = useAppSelector(
    (state) => state.startupCoordinator.target,
  );
  const managedCloudRuntime = isManagedCloudRuntime(runtimeTarget);
  const route = managedRouteForPath(location.pathname);

  if (!managedCloudRuntime) {
    return (
      <ManagedCloudUnavailable message="Cloud management is available for agents deployed to Eliza Cloud." />
    );
  }

  if (!session.ready) {
    return <ManagedCloudUnavailable message="Loading Cloud management…" />;
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
