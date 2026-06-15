import { type ComponentType, Suspense, useEffect, useMemo } from "react";
import { getOverlayAppLazyComponent } from "./AppWindowRenderer.helpers";
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
