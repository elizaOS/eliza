"use client";

import { useEffect } from "react";

/**
 * Handles deep link redirects for Privy OAuth flows and app navigation in Capacitor.
 *
 * Per Privy Capacitor docs: this component intercepts OAuth redirect deep links
 * that contain `privy_oauth_code`, `privy_oauth_state`, and `privy_oauth_provider`
 * query params, and injects them into the current WebView URL so Privy's SDK
 * can complete the OAuth flow.
 *
 * For non-OAuth deep links (e.g., /post/123), it navigates to the path.
 *
 * Must be mounted BEFORE PrivyProvider in the component tree.
 */
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

        // Handle Privy OAuth redirects — these come back from the external
        // browser after social login (Farcaster, Twitter, Discord, etc.)
        if (
          deepLinkUrl.searchParams.has("privy_oauth_code") &&
          deepLinkUrl.searchParams.has("privy_oauth_state") &&
          deepLinkUrl.searchParams.has("privy_oauth_provider")
        ) {
          // Inject the OAuth params into the current WebView URL
          // so Privy's SDK can pick them up and complete authentication
          const currentUrl = new URL(window.location.href);
          currentUrl.search = deepLinkUrl.search;
          window.location.assign(currentUrl.toString());
          return;
        }

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
