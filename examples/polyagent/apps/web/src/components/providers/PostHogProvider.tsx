"use client";

import { usePathname, useSearchParams } from "next/navigation";
/**
 * PostHog provider component for initializing PostHog analytics.
 *
 * Initializes PostHog analytics client and automatically tracks page views
 * as users navigate. Provides PostHog context to child components.
 *
 * Features:
 * - PostHog initialization
 * - Page view tracking
 * - URL parameter tracking
 * - Automatic navigation tracking
 *
 * @param props - PostHogProvider component props
 * @returns PostHog provider element
 */
import { useEffect, useRef } from "react";
import { initPostHog, posthog } from "@/lib/posthog";

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialized = useRef(false);

  // Initialize PostHog once
  useEffect(() => {
    if (!initialized.current) {
      initPostHog();
      initialized.current = true;
    }
  }, []);

  // Track page views
  useEffect(() => {
    if (pathname) {
      let url = window.origin + pathname;
      if (searchParams?.toString()) {
        url = `${url}?${searchParams.toString()}`;
      }

      // Track pageview with PostHog
      if (typeof window !== "undefined" && posthog) {
        posthog.capture("$pageview", {
          $current_url: url,
          $pathname: pathname,
          $search_params: searchParams?.toString() || "",
        });
      }
    }
  }, [pathname, searchParams]);

  return <>{children}</>;
}
