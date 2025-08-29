// Sentry integration for ElizaOS with AI telemetry support

// Note: We use console.log instead of the logger here to avoid circular dependencies.
// The logger imports Sentry for exception capture, so we can't import logger here.
// Additionally, console.log is appropriate for initialization messages that should
// always be visible during startup regardless of log level configuration.

// Conditional import for Node.js environments only
let Sentry: typeof import('@sentry/node');

// Only import Sentry in Node.js environments (not browser)
if (typeof globalThis !== 'undefined' && typeof process !== 'undefined' && process.versions?.node) {
  try {
    Sentry = require('@sentry/node');
  } catch (error) {
    console.warn('[SENTRY] Failed to import @sentry/node:', error);
  }
}

// TypeScript interfaces for better type safety
interface TelemetryParams {
  experimental_telemetry?: {
    isEnabled?: boolean;
    functionId?: string;
    recordInputs?: boolean;
    recordOutputs?: boolean;
  };
  // Allow other properties that might be passed to AI SDK calls
  [key: string]: unknown;
}

/**
 * Initialize Sentry with AI telemetry support
 * @param dsn - Optional DSN override, defaults to SENTRY_DSN env var
 */
export function initializeSentry(dsn?: string): void {
  // Only initialize in Node.js environments
  if (!Sentry) {
    console.log('[SENTRY] Not available in browser environment - skipped');
    return;
  }

  const effectiveDsn = dsn ?? process.env.SENTRY_DSN;

  if (!effectiveDsn) {
    console.log('[SENTRY] No DSN provided - Sentry disabled');
    return;
  }

  if (process.env.SENTRY_LOGGING === 'false') {
    console.log('[SENTRY] Explicitly disabled via SENTRY_LOGGING=false');
    return;
  }

  console.log('[SENTRY] Initializing with DSN:', effectiveDsn.substring(0, 20) + '...');

  const traceFilter = process.env.SENTRY_TRACE_FILTER === 'false' ? 'all traces' : 'AI-only traces';
  console.log('[SENTRY] Trace filtering:', traceFilter, '+ all errors');

  try {
    Sentry.init({
      dsn: effectiveDsn,
      environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
      tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '') || 1.0,
      sendDefaultPii: process.env.SENTRY_SEND_DEFAULT_PII === 'true',

      // Configurable trace filtering (errors are always captured)
      beforeSendTransaction(transaction) {
        // Always skip Sentry's own internal traces
        if (
          transaction.transaction?.includes('/envelope/') ||
          transaction.transaction?.includes('sentry')
        ) {
          return null;
        }

        // SENTRY_TRACE_FILTER=false: Capture all traces
        if (process.env.SENTRY_TRACE_FILTER === 'false') {
          return transaction;
        }

        // Default SENTRY_TRACE_FILTER=ai-only: Only AI-related traces
        const keepTrace: boolean =
          transaction.transaction?.includes('generateText') ||
          transaction.transaction?.includes('ai.') ||
          transaction.transaction?.includes('anthropic') ||
          transaction.transaction?.includes('openai') ||
          transaction.spans?.some(
            (span) =>
              span.description?.includes('generateText') ||
              span.description?.includes('ai.') ||
              span.op?.includes('ai.')
          );

        return keepTrace ? transaction : null;
      },

      integrations: [
        // Vercel AI SDK telemetry integration
        Sentry.vercelAIIntegration({
          recordInputs: true,
          recordOutputs: true,
        }),
        // HTTP integration with noise filtering
        Sentry.httpIntegration({
          ignoreIncomingRequests: (url) => {
            return (
              url.includes('/envelope/') || url.includes('localhost') || url.includes('127.0.0.1')
            );
          },
        }),
      ],
    });

    console.log('[SENTRY] Node.js initialized successfully');
  } catch (error) {
    console.error('[SENTRY] Failed to initialize:', error);
  }
}

/**
 * Utility to add telemetry options to AI SDK calls
 * Use this in plugin-anthropic, plugin-openai, etc.
 * @param params - The parameters for the AI SDK call
 * @param functionId - Optional function identifier for telemetry
 * @returns The params with telemetry options added
 */
export function withSentryTelemetry(
  params: TelemetryParams,
  functionId: string = 'eliza-ai-call'
): TelemetryParams {
  return {
    ...params,
    experimental_telemetry: {
      isEnabled: true,
      functionId,
      recordInputs: true,
      recordOutputs: true,
      ...params.experimental_telemetry, // Allow override
    },
  };
}

// Export Sentry for use by other modules (e.g., logger)
// Create a safe export that works in both Node.js and browser environments
export const SentryInstance = Sentry || {
  captureException: () => {},
  captureMessage: () => {},
  startSpan: (_options: any, callback: any) => callback?.(),
  startTransaction: () => ({
    startChild: () => ({ finish: () => {} }),
    finish: () => {}
  })
};

// For backward compatibility
export { SentryInstance as Sentry };

// Auto-initialize if SENTRY_DSN is set and we're in a Node.js environment
if (Sentry && process.env.SENTRY_DSN && process.env.SENTRY_LOGGING !== 'false') {
  initializeSentry();
}
