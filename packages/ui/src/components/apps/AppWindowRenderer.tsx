import { useEffect, useMemo } from "react";
import { getAppSlug } from "./helpers";
import type { OverlayApp } from "./overlay-app-api";
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

  return (
    <app.Component
      exitToApps={() => {
        window.location.href = "/apps";
      }}
      uiTheme={
        document.documentElement.classList.contains("dark") ? "dark" : "light"
      }
      t={(key) => key}
    />
  );
}
