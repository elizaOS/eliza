import { type ComponentType, lazy, Suspense, useEffect, useMemo } from "react";
import { getAppSlug } from "./helpers";
import type { OverlayApp, OverlayAppContext } from "./overlay-app-api";
import { getAvailableOverlayApps } from "./overlay-app-registry";

export interface AppWindowRendererProps {
  slug: string;
}

function resolveOverlayAppBySlug(slug: string): OverlayApp | undefined {
  const normalizedSlug = slug.toLowerCase();
  return getAvailableOverlayApps().find(
    (app) => getAppSlug(app.name).toLowerCase() === normalizedSlug,
  );
}

const lazyComponentCache = new WeakMap<
  NonNullable<OverlayApp["loader"]>,
  ComponentType<OverlayAppContext>
>();

export function getOverlayAppLazyComponent(
  app: OverlayApp,
): ComponentType<OverlayAppContext> | null {
  if (!app.loader) return null;
  const existing = lazyComponentCache.get(app.loader);
  if (existing) return existing;
  const created = lazy(app.loader);
  lazyComponentCache.set(app.loader, created);
  return created;
}

function getLazyComponentForApp(
  app: OverlayApp,
): ComponentType<OverlayAppContext> | null {
  return getOverlayAppLazyComponent(app);
}

function AppFallback(): React.ReactElement {
  return (
    <div className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground" />
  );
}

export function AppWindowRenderer({
  slug,
}: AppWindowRendererProps): React.ReactElement {
  const app = useMemo(() => resolveOverlayAppBySlug(slug), [slug]);

  useEffect(() => {
    void app?.onLaunch?.();
    return () => {
      void app?.onStop?.();
    };
  }, [app]);

  if (!app) {
    return (
      <div className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground">
        App not found: {slug}
      </div>
    );
  }

  const context: OverlayAppContext = {
    exitToApps: () => {
      window.location.href = "/apps";
    },
    uiTheme: document.documentElement.classList.contains("dark")
      ? "dark"
      : "light",
    t: (key) => key,
  };

  const LazyComponent = getLazyComponentForApp(app);
  if (LazyComponent) {
    return (
      <Suspense fallback={<AppFallback />}>
        <LazyComponent {...context} />
      </Suspense>
    );
  }

  if (app.Component) {
    return <app.Component {...context} />;
  }

  return (
    <div className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground">
      App has no component: {slug}
    </div>
  );
}
