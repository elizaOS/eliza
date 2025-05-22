import * as Sentry from '@sentry/browser';

const dsn =
  process.env.SENTRY_DSN ||
  'https://c20e2d51b66c14a783b0689d536f7e5c@o4509349865259008.ingest.us.sentry.io/4509352524120064';
if (process.env.SENTRY_LOGGING !== 'false') {
  Sentry.onLoad(() => {
    Sentry.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV,
      tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '') || 1.0,
      sendDefaultPii: process.env.SENTRY_SEND_DEFAULT_PII === 'true',
    });
  });
}

export { Sentry };
