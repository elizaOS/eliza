/**
 * Sentry Server Configuration
 *
 * This file configures Sentry for the server-side of the Next.js application.
 * It captures errors from API routes, server components, and server-side rendering.
 *
 * Best practices as of December 2024:
 * - Uses tracesSampler for dynamic sampling control
 * - Includes proper Node.js integrations
 * - Filters out non-actionable errors
 * - Adds proper context and tags
 */

import * as Sentry from "@sentry/nextjs";

// Suppress noisy Sentry logger messages from Next.js integration
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

console.log = (...args: Parameters<typeof console.log>) => {
  const message = args.join(" ");
  // Only filter Next.js Sentry logger messages
  if (
    message.includes("[next] Sentry Logger") &&
    (message.includes("SpanExporter exported") ||
      message.includes("spans are waiting"))
  ) {
    return;
  }
  originalConsoleLog(...args);
};

console.error = (...args: Parameters<typeof console.error>) => {
  const message = args.join(" ");
  // Only filter Next.js Sentry "Transport disabled" error
  if (
    message.includes("[next] Sentry Logger") &&
    message.includes("Transport disabled")
  ) {
    return;
  }
  originalConsoleError(...args);
};

const rawServerDsn =
  process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;
const isPlaceholderServerDsn =
  rawServerDsn?.includes("your-dsn") === true ||
  rawServerDsn?.includes("project-id") === true;
const effectiveServerDsn = isPlaceholderServerDsn ? undefined : rawServerDsn;

// Log initialization status in development
if (process.env.NODE_ENV === "development") {
  if (!effectiveServerDsn) {
    console.warn(
      "[Sentry Server] SENTRY_DSN or NEXT_PUBLIC_SENTRY_DSN is not configured. Add it to your .env.local file to enable error tracking.",
    );
  } else {
    console.log(
      "[Sentry Server] Initializing with DSN:",
      `${effectiveServerDsn.substring(0, 20)}...`,
    );
  }
}

Sentry.init({
  dsn: effectiveServerDsn,

  // Environment detection
  environment: process.env.NODE_ENV || "development",

  // Release tracking (set via environment variable or CI/CD)
  release: process.env.SENTRY_RELEASE || process.env.NEXT_PUBLIC_SENTRY_RELEASE,

  // Debug mode disabled to suppress verbose logging
  debug: false,

  // Performance monitoring with dynamic sampling
  tracesSampler: (samplingContext) => {
    // Sample 100% of transactions in development
    if (process.env.NODE_ENV === "development") {
      return 1.0;
    }

    // In production, use different rates based on context
    const { request } = samplingContext;

    // Sample more of important API endpoints
    if (request?.url) {
      const url = request.url;

      // Health checks - don't sample
      if (url.includes("/api/health") || url.includes("/health")) {
        return 0;
      }

      // Critical endpoints - sample more
      if (url.includes("/api/game/") || url.includes("/api/markets/")) {
        return 0.3; // 30% of critical endpoints
      }

      // Regular API endpoints
      if (url.includes("/api/")) {
        return 0.1; // 10% of API calls
      }
    }

    // Default sample rate
    return 0.1;
  },

  // Profiling (optional, for performance analysis)
  profilesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,

  // Filter out common non-actionable errors
  ignoreErrors: [
    // Validation errors (handled by error handler, don't need Sentry)
    "ZodError",
    // Authentication errors (handled by error handler)
    "UnauthorizedError",
    // Common non-actionable errors
    "ECONNREFUSED", // Connection refused (often infrastructure)
    "ETIMEDOUT", // Timeout errors (often infrastructure)
  ],

  // Server-specific integrations
  integrations: [
    // Automatically instrument Node.js HTTP/HTTPS modules
    Sentry.httpIntegration(),
  ],

  // Before send hook for additional filtering and context
  beforeSend(event, hint) {
    // Don't send events if DSN is not configured
    if (!process.env.SENTRY_DSN && !process.env.NEXT_PUBLIC_SENTRY_DSN) {
      if (process.env.NODE_ENV === "development") {
        console.warn(
          "[Sentry] SENTRY_DSN or NEXT_PUBLIC_SENTRY_DSN is not configured. Events will not be sent to Sentry.",
        );
      }
      return null;
    }

    // Add additional context from request
    if (event.request) {
      // Add user context if available
      const userId = event.request.headers?.["x-user-id"];
      if (userId && typeof userId === "string") {
        event.user = {
          id: userId,
        };
      }

      // Add request ID if available
      const requestId = event.request.headers?.["x-request-id"];
      if (requestId) {
        event.tags = {
          ...event.tags,
          requestId: requestId as string,
        };
      }
    }

    // Filter out known non-actionable errors
    const error = hint.originalException;
    if (error instanceof Error) {
      // Skip validation errors (already handled)
      if (error.name === "ZodError" || error.message.includes("validation")) {
        return null;
      }

      // Skip authentication errors (already handled)
      if (
        error.message.includes("unauthorized") ||
        error.message.includes("authentication") ||
        error.message.includes("forbidden")
      ) {
        return null;
      }
    }

    return event;
  },

  // Before send transaction hook for performance monitoring
  beforeSendTransaction(event) {
    // Filter out health check endpoints
    if (
      event.transaction === "/api/health" ||
      event.transaction === "/health" ||
      event.transaction?.includes("/_next/")
    ) {
      return null;
    }
    return event;
  },
});
