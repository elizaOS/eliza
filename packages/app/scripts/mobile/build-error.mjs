/** Constructs actionable failures at the mobile build boundary. */
import { ElizaError } from "../lib/eliza-error.mjs";

export function mobileBuildError(
  message,
  { cause, code = "MOBILE_BUILD_FAILED", context, severity = "fatal" } = {},
) {
  return new ElizaError(message, {
    cause,
    code,
    context: {
      subsystem: "mobile-build",
      ...context,
    },
    severity,
  });
}
