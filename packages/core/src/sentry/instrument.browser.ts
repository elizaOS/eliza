import { getEnv, getBooleanEnv, getNumberEnv } from '../utils/environment';

type SentryBrowserModule = {
  init: (options: Record<string, any>) => void;
  captureException: (error: unknown) => void;
  flush?: (timeout?: number) => Promise<boolean>;
  onLoad?: (cb: () => void) => void;
};

let initialized = false;
let sentryClient: SentryBrowserModule | null = null;

async function ensureSentryInitialized(): Promise<SentryBrowserModule | null> {
  if (getEnv('SENTRY_LOGGING') === 'false') return null;

  const dsn =
    getEnv('SENTRY_DSN') ||
    'https://c20e2d51b66c14a783b0689d536f7e5c@o4509349865259008.ingest.us.sentry.io/4509352524120064';

  if (initialized && sentryClient) return sentryClient;

  try {
    const mod = (await import('@sentry/browser')) as unknown as SentryBrowserModule;

    const init = () =>
      mod.init({
        dsn,
        environment: getEnv('SENTRY_ENVIRONMENT') || getEnv('NODE_ENV', 'development'),
        tracesSampleRate: (getNumberEnv('SENTRY_TRACES_SAMPLE_RATE', 1.0) as number) ?? 1.0,
        sendDefaultPii: getBooleanEnv('SENTRY_SEND_DEFAULT_PII', false),
      });

    if (typeof mod.onLoad === 'function') {
      mod.onLoad(init);
    } else {
      init();
    }

    initialized = true;
    sentryClient = mod;
    return sentryClient;
  } catch {
    initialized = true;
    sentryClient = null;
    return null;
  }
}

export const Sentry = {
  async captureException(error: unknown) {
    const client = await ensureSentryInitialized();
    try {
      client?.captureException?.(error);
    } catch {}
  },
  async flush(timeout?: number): Promise<boolean> {
    const client = await ensureSentryInitialized();
    try {
      if (client?.flush) return await client.flush(timeout);
    } catch {}
    return true;
  },
};

export type { SentryBrowserModule };
