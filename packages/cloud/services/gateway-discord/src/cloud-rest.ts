/** Keeps internal Cloud REST bodies under the request deadline without discarding caller cancellation or response diagnostics. */
import { boundedFetch } from "@elizaos/cloud-services-common/bounded-fetch";
import { ElizaError } from "@elizaos/core/errors";

export const HTTP_TIMEOUT_MS = 10_000;

export async function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeout?: number } = {},
): Promise<Response> {
  const { timeout = HTTP_TIMEOUT_MS, ...init } = options;
  return boundedFetch(url, init, {
    timeoutMs: timeout,
    maxResponseBytes: Number.MAX_SAFE_INTEGER,
    invalidBoundsError: () =>
      new ElizaError("Invalid Cloud REST deadline", {
        code: "DISCORD_CLOUD_REST_INVALID_DEADLINE",
      }),
    responseTooLargeError: (context) =>
      new ElizaError("Cloud REST response exceeds the transport boundary", {
        code: "DISCORD_CLOUD_REST_RESPONSE_TOO_LARGE",
        context,
      }),
    timeoutMessage: "Cloud REST response deadline exceeded",
    cancellationMessage: "Cloud REST request cancelled",
  });
}

/** State-update callers have no response consumer to check HTTP failures. */
export async function sendCloudUpdate(
  url: string,
  options: RequestInit & { timeout?: number },
): Promise<void> {
  const response = await fetchWithTimeout(url, options);
  if (!response.ok) {
    throw new ElizaError(
      `Cloud state update failed (${response.status}): ${await response.text()}`,
      {
        code: "DISCORD_CLOUD_UPDATE_FAILED",
        context: { status: response.status },
      },
    );
  }
}
