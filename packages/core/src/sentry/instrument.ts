// Sentry integration for ElizaOS with AI telemetry support

// Note: We use console.log instead of the logger here to avoid circular dependencies.
// The logger imports Sentry for exception capture, so we can't import logger here.
// Additionally, console.log is appropriate for initialization messages that should
// always be visible during startup regardless of log level configuration.

import * as Sentry from '@sentry/node';

// TypeScript interfaces for better type safety
interface SentrySpan {
  description?: string;
  op?: string;
}

interface TelemetryParams {
  experimental_telemetry?: {
    isEnabled?: boolean;
    functionId?: string;
    recordInputs?: boolean;
    recordOutputs?: boolean;
  };
  [key: string]: any;
}

/**
 * Initialize Sentry with AI telemetry support
 * @param dsn - Optional DSN override, defaults to SENTRY_DSN env var
 */
export function initializeSentry(dsn?: string): void {
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

  try {
    Sentry.init({
      dsn: effectiveDsn,
      environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
      tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '') || 1.0,
      sendDefaultPii: process.env.SENTRY_SEND_DEFAULT_PII === 'true',

      // Filter out noise traces - only keep AI-related traces
      beforeSendTransaction(transaction) {
        // Skip Sentry's own internal traces
        if (
          transaction.transaction?.includes('/envelope/') ||
          transaction.transaction?.includes('sentry')
        ) {
          return null;
        }

        // Only keep AI-related traces
        const keepTrace =
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
              url.includes('/envelope/') ||
              url.includes('localhost') ||
              url.includes('127.0.0.1')
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
export function withSentryTelemetry(params: TelemetryParams, functionId: string = 'eliza-ai-call'): TelemetryParams {
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
export { Sentry };

// Auto-initialize if SENTRY_DSN is set
if (process.env.SENTRY_DSN && process.env.SENTRY_LOGGING !== 'false') {
  initializeSentry();
}
