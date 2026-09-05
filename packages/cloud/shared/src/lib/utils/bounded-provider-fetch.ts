/** Maps cloud messaging provider bounds and typed failures to the shared REST transport. */
import { boundedFetch } from "@elizaos/cloud-services-common/bounded-fetch";
import { ElizaError } from "@elizaos/core/errors";

export interface BoundedProviderFetchOptions {
  /** Provider name used in error context, e.g. "twilio". */
  readonly provider: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly fetchImpl?: typeof fetch;
}

export async function boundedProviderFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  { provider, timeoutMs, maxResponseBytes, fetchImpl }: BoundedProviderFetchOptions,
): Promise<Response> {
  return boundedFetch(input, init, {
    timeoutMs,
    maxResponseBytes,
    fetchImpl,
    timeoutMessage: "Provider request deadline expired",
    cancellationMessage: "Provider request cancelled",
    invalidBoundsError: () =>
      new ElizaError("Provider request bounds must be timer-safe positive integers", {
        code: "INVALID_PROVIDER_REQUEST_BOUNDS",
        context: { provider, timeoutMs, maxResponseBytes },
      }),
    responseTooLargeError: (context) =>
      new ElizaError("Provider response exceeds the allowed byte limit", {
        code: "PROVIDER_RESPONSE_TOO_LARGE",
        context: { provider, ...context },
      }),
  });
}
