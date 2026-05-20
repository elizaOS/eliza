/**
 * Sentry Edge Configuration
 *
 * Initializes Sentry for Edge Runtime surfaces (middleware, edge route handlers).
 * We keep this config lightweight and Node-free.
 */

import * as Sentry from '@sentry/nextjs';

const sentryEdgeRelease =
  process.env.SENTRY_RELEASE ??
  process.env.VERCEL_GIT_COMMIT_SHA ??
  process.env.NEXT_PUBLIC_SENTRY_RELEASE ??
  process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA;

Sentry.init({
  dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,

  environment:
    process.env.SENTRY_ENVIRONMENT ??
    process.env.VERCEL_ENV ??
    process.env.NODE_ENV ??
    'development',

  release: sentryEdgeRelease,

  debug: false,

  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

  beforeSend(event) {
    if (!process.env.SENTRY_DSN && !process.env.NEXT_PUBLIC_SENTRY_DSN) {
      return null;
    }
    return event;
  },
});
