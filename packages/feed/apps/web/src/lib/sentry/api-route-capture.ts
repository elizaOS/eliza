import type { ErrorHandlerOptions, JsonValue } from "@feed/api";
import * as Sentry from "@sentry/nextjs";

type ErrorCaptureContext = Parameters<
  NonNullable<ErrorHandlerOptions["captureError"]>
>[1];

function toRecord(
  value: JsonValue | undefined,
): Record<string, JsonValue> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, JsonValue>;
}

function toString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getHeaderValue(
  headers: Record<string, JsonValue> | undefined,
  key: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }

  const targetKey = key.toLowerCase();
  for (const [headerKey, value] of Object.entries(headers)) {
    if (headerKey.toLowerCase() === targetKey && typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function getEndpointFromUrl(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }

  try {
    return new URL(url).pathname;
  } catch {
    return url.split("?")[0];
  }
}

/**
 * Creates the default Sentry capture callback used by @feed/api's withErrorHandling wrapper.
 */
export function createSentryApiRouteCapture(): NonNullable<
  ErrorHandlerOptions["captureError"]
> {
  return (error: Error, context: ErrorCaptureContext): void => {
    const request = toRecord(context.request);
    const headers = toRecord(request?.headers);
    const requestUrl = toString(request?.url);
    const requestMethod = toString(request?.method);
    const requestId = getHeaderValue(headers, "x-request-id");
    const endpoint = getEndpointFromUrl(requestUrl);
    const user = toRecord(context.user);
    const userId = toString(user?.id);

    Sentry.withScope((scope) => {
      scope.setTag("runtime", "nodejs");
      scope.setTag("surface", "api-route");

      if (requestMethod) {
        scope.setTag("method", requestMethod);
      }
      if (endpoint) {
        scope.setTag("endpoint", endpoint);
      }
      if (requestId) {
        scope.setTag("requestId", requestId);
      }
      if (userId) {
        scope.setUser({ id: userId });
      }

      scope.setContext("apiRoute", {
        method: requestMethod,
        endpoint,
        requestId,
      });
      scope.setContext("apiErrorContext", context);

      Sentry.captureException(error);
    });
  };
}
