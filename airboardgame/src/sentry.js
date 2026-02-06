import * as Sentry from "@sentry/react";
import { BrowserTracing } from "@sentry/tracing";
import { SENTRY_DSN, SENTRY_ENVIRONMENT } from "./utils/settings";

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    integrations: [new BrowserTracing()],
    environment: SENTRY_ENVIRONMENT,

    tracesSampleRate: 1.0,
  });
}
