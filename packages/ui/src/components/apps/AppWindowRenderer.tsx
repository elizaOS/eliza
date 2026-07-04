/**
 * Resolves an overlay app by slug and mounts its lazily-loaded component in a
 * Suspense boundary — the render path behind an `/apps/<slug>` window route.
 * Because overlay apps register asynchronously off the first-paint critical
 * path, a deep-linked window can mount before its app registers, so this
 * re-resolves on a short bounded poll before settling on "App not found".
 */

import {
  type ComponentType,
  Suspense,
  useCallback,
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

  // Read the theme from the DOM in an effect (not during render) and keep it in
  // sync as the document class toggles, so the memoized context only changes when
  // the theme actually changes.
  const [uiTheme, setUiTheme] = useState<OverlayAppContext["uiTheme"]>(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );
  useEffect(() => {
    const root = document.documentElement;
    const sync = () =>
      setUiTheme(root.classList.contains("dark") ? "dark" : "light");
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  const exitToApps = useCallback(() => {
    window.location.href = "/apps";
  }, []);

  // Stable identity so embedded apps can use React.memo: only changes when a
  // render-affecting field (exitToApps / uiTheme) actually changes.
  const context = useMemo<OverlayAppContext>(
    () => ({
      exitToApps,
      uiTheme,
      t: (key) => key,
    }),
    [exitToApps, uiTheme],
  );

  if (!app) {
    return (
      <div className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground">
        App not found: {slug}
      </div>
    );
  }

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
