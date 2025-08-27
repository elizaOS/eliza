import * as Sentry from '@sentry/browser';
import { getEnv, getBooleanEnv, getNumberEnv } from '../utils/environment';

const dsn =
  getEnv('SENTRY_DSN') ||
  'https://c20e2d51b66c14a783b0689d536f7e5c@o4509349865259008.ingest.us.sentry.io/4509352524120064';

if (getEnv('SENTRY_LOGGING') !== 'false') {
  Sentry.onLoad(() => {
    Sentry.init({
      dsn,
      environment: getEnv('SENTRY_ENVIRONMENT') || getEnv('NODE_ENV', 'development'),
      tracesSampleRate: getNumberEnv('SENTRY_TRACES_SAMPLE_RATE', 1.0) as number,
      sendDefaultPii: getBooleanEnv('SENTRY_SEND_DEFAULT_PII', false),
    });
  });
}

export { Sentry };