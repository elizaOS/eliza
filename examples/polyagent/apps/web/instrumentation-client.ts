/**
 * Sentry Client Configuration (instrumentation-client.ts)
 *
 * This file configures Sentry for the browser/client-side of the Next.js application.
 * It captures errors, unhandled promise rejections, and performance data from the client.
 *
 * For Next.js 16+, this file replaces sentry.client.config.ts for Turbopack compatibility.
 * Best practices as of December 2024:
 * - Uses browserTracingIntegration for automatic performance monitoring
 * - Uses replayIntegration for session replay
 * - Implements tracesSampler for dynamic sampling control
 * - Filters out non-actionable errors
 * - Configures proper environment and release tracking
 */

import * as Sentry from "@sentry/nextjs";

const rawClientDsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
const isPlaceholderClientDsn =
  rawClientDsn?.includes("your-dsn") === true ||
  rawClientDsn?.includes("project-id") === true;
const effectiveClientDsn = isPlaceholderClientDsn ? undefined : rawClientDsn;

const sentryDisabled =
  process.env.NEXT_PUBLIC_DISABLE_SENTRY === "true" ||
  process.env.DISABLE_SENTRY === "true" ||
  !effectiveClientDsn;

// Log initialization status in development
if (process.env.NODE_ENV === "development") {
  if (sentryDisabled) {
    console.info("[Sentry Client] Disabled via DISABLE_SENTRY flag");
  } else if (!effectiveClientDsn) {
    console.warn(
      "[Sentry Client] NEXT_PUBLIC_SENTRY_DSN is not configured. Add it to your .env.local file to enable error tracking.",
    );
  } else {
    console.log(
      "[Sentry Client] Initializing with DSN:",
      `${effectiveClientDsn.substring(0, 20)}...`,
    );
  }
}

if (!sentryDisabled) {
  Sentry.init({
    dsn: effectiveClientDsn,

    // Environment detection
    environment: process.env.NODE_ENV || "development",

    // Release tracking (set via environment variable or CI/CD)
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,

    // Debug mode disabled to suppress verbose logging
    debug: false,

    // Performance monitoring with dynamic sampling
    // Use tracesSampler for better control over transaction sampling
    tracesSampler: (samplingContext) => {
      // Sample 100% of transactions in development
      if (process.env.NODE_ENV === "development") {
        return 1.0;
      }

      // In production, use different rates based on context
      const { request } = samplingContext;

      // Sample more of important transactions
      if (request?.url?.includes("/api/")) {
        return 0.2; // 20% of API calls
      }

      // Sample less of page navigations (high volume)
      if (request?.url) {
        return 0.1; // 10% of page loads
      }

      // Default sample rate
      return 0.1;
    },

    // Session Replay configuration
    replaysOnErrorSampleRate: 1.0, // Always record replays when errors occur
    replaysSessionSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0, // 10% of sessions in prod, 100% in dev

    // Profiling (optional, for performance analysis)
    profilesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,

    // Filter out common non-actionable errors
    ignoreErrors: [
      // Browser extensions
      "top.GLOBALS",
      "originalCreateNotification",
      "canvas.contentDocument",
      "MyApp_RemoveAllHighlights",
      "atomicFindClose",
      "fb_xd_fragment",
      "bmi_SafeAddOnload",
      "conduitPage",
      // Network errors that are often not actionable
      "NetworkError",
      "Network request failed",
      "Failed to fetch",
      // Privacy/Ad blockers
      "Blocked a frame with origin",
      "ResizeObserver loop limit exceeded",
      // Chrome extensions
      "chrome-extension://",
      "moz-extension://",
    ],

    // Filter out URLs that shouldn't be tracked
    denyUrls: [
      // Chrome extensions
      /extensions\//i,
      /^chrome:\/\//i,
      /^chrome-extension:\/\//i,
      /^moz-extension:\/\//i,
      // Browser internals
      /^about:/i,
    ],

    // Integrations - use latest recommended integrations
    integrations: [
      Sentry.browserTracingIntegration({
        // Enable tracing for all navigation
        enableInp: true, // Interaction to Next Paint (INP) monitoring
      }),
      Sentry.replayIntegration({
        // Privacy settings
        maskAllText: true,
        blockAllMedia: true,
        // Performance settings
        networkDetailAllowUrls: [
          // Only capture network details for your API
          new RegExp(process.env.NEXT_PUBLIC_API_URL || ".*"),
        ],
        networkCaptureBodies: true,
      }),
      Sentry.captureConsoleIntegration({
        levels: ["error"], // Only capture console.error
      }),
    ],

    // Before send hook for additional filtering
    beforeSend(event, hint) {
      // Don't send events if DSN is not configured
      if (!process.env.NEXT_PUBLIC_SENTRY_DSN) {
        if (process.env.NODE_ENV === "development") {
          console.warn(
            "[Sentry] NEXT_PUBLIC_SENTRY_DSN is not configured. Events will not be sent to Sentry.",
          );
        }
        return null;
      }

      // Filter out development-only errors in production
      if (process.env.NODE_ENV === "production" && event.exception) {
        const error = hint.originalException;
        if (error instanceof Error) {
          // Filter out common development errors
          if (
            error.message.includes("development") ||
            error.message.includes("localhost") ||
            error.message.includes("Hydration")
          ) {
            return null;
          }
        }
      }

      return event;
    },

    // Before send transaction hook for performance monitoring
    beforeSendTransaction(event) {
      // Filter out health check endpoints
      if (
        event.transaction === "/api/health" ||
        event.transaction === "/health"
      ) {
        return null;
      }
      return event;
    },
  });
}

// Export router transition handler for Next.js App Router
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
