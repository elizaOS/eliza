/** Maps gateway provider bounds and public error identity to the shared REST transport. */
import { boundedFetch } from "@elizaos/cloud-services-common/bounded-fetch";

export class GatewayProviderFetchError extends Error {
  override readonly name = "GatewayProviderFetchError";

  constructor(
    readonly code: "INVALID_GATEWAY_TIMEOUT" | "GATEWAY_RESPONSE_TOO_LARGE",
    message: string,
    readonly context: Record<string, unknown>,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export async function boundedGatewayFetch(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<Response> {
  return boundedFetch(input, init, {
    timeoutMs,
    maxResponseBytes,
    fetchImpl,
    timeoutMessage: "Provider request deadline expired",
    cancellationMessage: "Provider request cancelled",
    invalidBoundsError: () =>
      new GatewayProviderFetchError(
        "INVALID_GATEWAY_TIMEOUT",
        "Gateway provider bounds must be timer-safe positive integers",
        { timeoutMs, maxResponseBytes },
      ),
    responseTooLargeError: (context) =>
      new GatewayProviderFetchError(
        "GATEWAY_RESPONSE_TOO_LARGE",
        "Gateway provider response exceeds the byte limit",
        context,
      ),
  });
}
