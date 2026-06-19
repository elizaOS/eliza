"use client";

import { useEffect } from "react";

/** Handles app deep links in Capacitor native shells. */
export function AppUrlListener({
  onNavigate,
}: {
  onNavigate?: (path: string) => void;
}) {
  useEffect(() => {
    let cleanup: (() => void) | undefined;

    async function init() {
      // Only load Capacitor plugins in native context
      const { Capacitor } = await import("@capacitor/core");
      if (!Capacitor.isNativePlatform()) return;

      const { App } = await import("@capacitor/app");

      const listener = await App.addListener("appUrlOpen", (event) => {
        const deepLinkUrl = new URL(event.url);

        // Handle app deep links (e.g., feed.market/post/123)
        const path = deepLinkUrl.pathname + deepLinkUrl.search;
        if (path && path !== "/") {
          if (onNavigate) {
            onNavigate(path);
          } else {
            window.location.href = path;
          }
        }
      });

      cleanup = () => listener.remove();
    }

    init();
    return () => cleanup?.();
  }, [onNavigate]);

  return null;
}
