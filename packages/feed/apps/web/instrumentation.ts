/**
 * Next.js Instrumentation
 *
 * Runs on server startup to bootstrap NPC agents and initialize Sentry.
 * This file handles server-side Sentry initialization.
 *
 * Note: Client-side Sentry is initialized via instrumentation-client.ts
 */

import * as Sentry from '@sentry/nextjs';

const sentryDisabled =
  process.env.DISABLE_SENTRY === 'true' ||
  process.env.NEXT_PUBLIC_DISABLE_SENTRY === 'true';

export async function register() {
  // Skip instrumentation during build phase
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return;
  }

  // Only initialize services in Node.js runtime (not Edge Runtime)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Dynamically import Node.js-only modules to avoid Edge Runtime errors
    // Import from main package entry point
    const {
      setReputationService,
      setNotificationService,
      setDefaultErrorCapture,
      ReputationService,
      createNotification,
      logDevCredentials,
    } = await import('@feed/api');
    const { createSentryApiRouteCapture } = await import(
      './src/lib/sentry/api-route-capture'
    );

    // Route-level captureError options still override this default.
    setDefaultErrorCapture(
      sentryDisabled ? undefined : createSentryApiRouteCapture()
    );

    // Log development credentials at startup (only in dev mode)
    // This makes it easy for developers to authenticate with admin APIs
    logDevCredentials();

    // Initialize agent service container with required services
    // Uses globalThis to persist across module instances
    const { setServiceContainer, agentRegistry, npcBootstrapService } =
      await import('@feed/agents');
    setServiceContainer({
      agentRegistry,
    });

    // Bootstrap NPC agents so they're registered for agent-tick processing
    // Note: Runs asynchronously and is non-critical; failures do not block server startup
    // Individual NPC failures are handled internally by npcBootstrapService
    void npcBootstrapService.bootstrapAllNpcs();

    // Initialize shared moderation services with web app implementations
    setReputationService({
      awardReputation: async (userId, amount, reason, metadata) => {
        // Cast metadata from Record<string, unknown> to Record<string, JsonValue>
        // JsonValue is a subset of unknown, so this cast is safe
        // JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
        return await ReputationService.awardReputation(
          userId,
          amount,
          reason as never,
          metadata as Parameters<typeof ReputationService.awardReputation>[3]
        );
      },
    });

    setNotificationService({
      createNotification: async (params) => {
        // Cast params to match CreateNotificationParams type
        // setNotificationService interface uses string for type, but createNotification expects NotificationType
        return await createNotification(
          params as Parameters<typeof createNotification>[0]
        );
      },
    });

    // Initialize API key lastUsedAt write-back cache flusher
    // WHY: Batches Redis updates and flushes to database periodically, reducing DB load by 90%+.
    // The write-back cache pattern stores updates in Redis first (fast), then batches them
    // into periodic database transactions (efficient). This solves the performance issue where
    // 1,830 individual UPDATE queries were taking 115,885 seconds of database time.
    // WHY globalThis check: Prevents multiple initializations in serverless environments where
    // module may be reloaded. Each serverless function invocation is a new process, but within
    // a single process (e.g., Next.js dev server), we only want one flusher running.
    const g = globalThis as typeof globalThis & {
      __lastUsedFlusherStarted?: boolean;
    };
    if (!g.__lastUsedFlusherStarted) {
      const { startLastUsedFlusher } = await import('@feed/api');
      startLastUsedFlusher();
      g.__lastUsedFlusherStarted = true;
    }
  }

  if (sentryDisabled && process.env.NODE_ENV === 'development') {
    console.info('[Sentry] Disabled via DISABLE_SENTRY flag');
  }

  // Initialize Sentry for server-side (Node.js runtime)
  if (!sentryDisabled && process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }

  // Initialize Sentry for Edge Runtime (middleware, edge route handlers)
  if (!sentryDisabled && process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

// Export request error handler for Next.js App Router
export const onRequestError = Sentry.captureRequestError;
