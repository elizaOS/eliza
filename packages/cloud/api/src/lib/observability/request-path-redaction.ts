/**
 * Removes sensitive device identifiers from request-path telemetry while
 * preserving route shape for operational diagnostics.
 */

const PUSH_TOKEN_PATH_SEGMENT =
  /(\/api\/notifications\/push-tokens\/)[^/?\s]+/g;

/** Keeps legacy push-token URLs from placing device identifiers in telemetry. */
export function redactSensitiveRequestPath(value: string): string {
  return value.replace(PUSH_TOKEN_PATH_SEGMENT, "$1[redacted]");
}
