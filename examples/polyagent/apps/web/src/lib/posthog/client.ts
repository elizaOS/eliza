"use client";

/**
 * PostHog Client Configuration
 * Client-side analytics and event tracking
 */

import posthog from "posthog-js";

export type PostHogClient = typeof posthog;

let initialized = false;

/**
 * Initialize PostHog client for browser
 */
export function initPostHog(): PostHogClient | null {
  if (typeof window === "undefined") return null;

  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const apiHost =
    process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com";

  if (!apiKey) {
    console.warn("PostHog: API key not found. Analytics will be disabled.");
    return null;
  }

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
      loaded: () => {
        if (process.env.NODE_ENV === "development") {
          console.log("PostHog initialized successfully");
        }
      },

      // Privacy
      respect_dnt: true, // Respect Do Not Track
      persistence: "localStorage+cookie", // Store data in localStorage and cookies

      // Advanced features
      enable_recording_console_log: process.env.NODE_ENV === "development", // Log console in dev

      // Error tracking
      capture_exceptions: true, // Automatically capture errors
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
