import {
  type ComponentType,
  Suspense,
  useEffect,
  useMemo,
  useState,
} from "react";
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

// Overlay apps register asynchronously: the host loads plugin side-effect
// modules off the first-paint critical path (idle-scheduled), so an app window
// opened deep-link/standalone can mount BEFORE its overlay app has registered.
// Re-resolve on a short bounded poll so a late-registering app is picked up
// instead of being stranded on a permanent "App not found".
const RESOLVE_RETRY_INTERVAL_MS = 120;
const RESOLVE_RETRY_WINDOW_MS = 8000;

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
  const initialApp = useMemo(() => resolveOverlayAppBySlug(slug), [slug]);
  const [app, setApp] = useState<OverlayApp | undefined>(initialApp);

  // Reset to the freshest synchronous resolution whenever the slug changes.
  useEffect(() => {
    setApp(resolveOverlayAppBySlug(slug));
  }, [slug]);

  // If the app isn't registered yet, poll the registry briefly until it shows
  // up (late async plugin registration) or the retry window elapses.
  useEffect(() => {
    if (app) return;
    const deadline = Date.now() + RESOLVE_RETRY_WINDOW_MS;
    const interval = window.setInterval(() => {
      const resolved = resolveOverlayAppBySlug(slug);
      if (resolved || Date.now() >= deadline) {
        window.clearInterval(interval);
        if (resolved) setApp(resolved);
      }
    }, RESOLVE_RETRY_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [app, slug]);

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
