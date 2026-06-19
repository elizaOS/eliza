"use client";

/**
 * PostHog Client Configuration
 * Client-side analytics and event tracking
 *
 * All events are automatically tagged with an `environment` super property
 * (production, staging, or development) so staging and production can be
 * filtered independently within a single PostHog project.
 */

import { logger } from "@feed/shared";
import posthog from "posthog-js";

export type PostHogClient = typeof posthog;

let initialized = false;

/**
 * Detect the client-side deployment environment.
 *
 * Uses NEXT_PUBLIC_VERCEL_ENV (injected by Vercel at build time) to distinguish
 * production, staging (preview), and development.
 */
function getClientEnvironment(): "production" | "staging" | "development" {
  const vercelEnv = process.env.NEXT_PUBLIC_VERCEL_ENV;
  if (vercelEnv === "production") return "production";
  if (vercelEnv === "preview") return "staging";
  if (process.env.NODE_ENV === "production") return "production";
  return "development";
}

/**
 * Initialize PostHog client for browser
 *
 * Uses NEXT_PUBLIC_POSTHOG_PROJECT_ID as the project API key.
 * Environment is detected automatically and registered as a super property
 * so every event can be filtered by staging vs production.
 */
export function initPostHog(): PostHogClient | null {
  if (typeof window === "undefined") return null;

  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_ID;
  const apiHost =
    process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com";

  if (!apiKey) {
    logger.warn(
      "NEXT_PUBLIC_POSTHOG_PROJECT_ID not found. Analytics will be disabled.",
      undefined,
      "PostHog",
    );
    return null;
  }

  const environment = getClientEnvironment();

  // Initialize PostHog only once
  if (!initialized) {
    posthog.init(apiKey, {
      api_host: apiHost,

      // Capture settings
      capture_pageview: false, // We'll handle this manually for better control
      capture_pageleave: true, // Track when users leave pages

      // Session recording
      session_recording: {
        maskAllInputs: true, // Mask sensitive input fields
        maskTextSelector: "[data-private]", // Custom selector for privacy
        recordCrossOriginIframes: false,
      },

      // Autocapture
      autocapture: {
        dom_event_allowlist: ["click", "submit", "change"], // Only capture specific events
        url_allowlist: [], // Allow all URLs
        element_allowlist: ["button", "a", "form"], // Only important elements
        css_selector_allowlist: ["[data-ph-capture]"], // Custom tracking attribute
      },

      // Performance
      loaded: (ph) => {
        // Register environment as a super property so it's attached to every event
        ph.register({
          environment,
          app_version: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || "dev",
          deployment_url:
            process.env.NEXT_PUBLIC_VERCEL_URL || "localhost:3000",
        });

        if (process.env.NODE_ENV === "development") {
          logger.info(
            "PostHog initialized",
            { environment, project: `${apiKey.slice(0, 12)}...` },
            "PostHog",
          );
        }
      },

      // Privacy
      respect_dnt: true, // Respect Do Not Track
      persistence: "localStorage+cookie", // Store data in localStorage and cookies

      // Advanced features
      enable_recording_console_log: process.env.NODE_ENV === "development", // Log console in dev

      // Keep global browser exception wrappers disabled; app-owned reporting stays explicit.
      capture_exceptions: false,
    });
    initialized = true;
  }

  return posthog;
}

/**
 * Get the PostHog client instance
 */
export function getPostHog(): PostHogClient | null {
  if (typeof window === "undefined") return null;
  return posthog;
}

export { posthog };
