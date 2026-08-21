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
import {
  overlayAgentSurfaceDescriptor,
  requireRegisteredAgentSurface,
} from "../../app-shell-registry";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import { getOverlayAppLazyComponent } from "./AppWindowRenderer.helpers";
import { getAppSlug } from "./helpers";
import type { OverlayApp, OverlayAppContext } from "./overlay-app-api";
import { getAvailableOverlayApps } from "./overlay-app-registry";

export interface AppWindowRendererProps {
  slug: string;
}

export interface OverlayAppSurfaceProps extends OverlayAppContext {
  app: OverlayApp;
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

/**
 * Mount one resolved overlay through the same generated bridge used by
 * registry-backed app-shell pages. Both the main-window overlay and detached
 * app-window renderer use this component, so lifecycle and interaction
 * ownership cannot drift between launch paths.
 */
export function OverlayAppSurface({
  app,
  exitToApps,
  uiTheme,
  t,
}: OverlayAppSurfaceProps): React.ReactElement {
  const descriptor = requireRegisteredAgentSurface(
    overlayAgentSurfaceDescriptor(app),
  );

  useEffect(() => {
    void app.onLaunch?.();
    return () => {
      void app.onStop?.();
    };
  }, [app]);

  const context = useMemo<OverlayAppContext>(
    () => ({ exitToApps, uiTheme, t }),
    [exitToApps, t, uiTheme],
  );
  const LazyComponent = getLazyComponentForApp(app);
  let content: React.ReactElement;
  if (LazyComponent) {
    content = (
      <Suspense fallback={<AppFallback />}>
        <LazyComponent {...context} />
      </Suspense>
    );
  } else if (app.Component) {
    content = <app.Component {...context} />;
  } else {
    content = (
      <div className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground">
        App has no component: {descriptor.viewId}
      </div>
    );
  }

  return (
    <ShellViewAgentSurface
      viewId={descriptor.viewId}
      surfaceKind={descriptor.kind}
    >
      {content}
    </ShellViewAgentSurface>
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
    // Exit a running overlay app back to the launcher grid, which lives at
    // `/views` (`/apps` is a retired My Apps deep link into Projects, #17031).
    window.location.href = "/views";
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
  return <OverlayAppSurface app={app} {...context} />;
}
