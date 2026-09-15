/**
 * Owns one REST hop through transport, bounded response buffering, and cleanup.
 *
 * Buffering retains only the bytes that actually arrive: chunks accumulate in a
 * list and are joined once into an exactly sized slab, so the byte ceiling caps
 * a hostile response without being pre-reserved by every ordinary one.
 */

import { boundedFetch } from "@elizaos/cloud-services-common/bounded-fetch";
import { ElizaError } from "@elizaos/core/errors";

// The largest legitimate shared-utils reply is a Cloudflare paged listing
// (`/zones/<id>/dns_records?per_page=200`), on the order of a hundred kilobytes;
// Twilio, Blooio, and Twitter hops return single-resource JSON. Four MiB is the
// headroom ceiling for those endpoints, and a caller with a genuinely larger
// endpoint raises its own `maxResponseBytes` rather than widening this default.
export const DEFAULT_REST_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
export const DEFAULT_REST_RESPONSE_MAX_CHUNKS = 8_192;

export interface OwnedBoundedFetchOptions {
  timeoutMs: number;
  maxResponseBytes?: number;
  maxResponseChunks?: number;
}

export async function ownedBoundedFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  options: OwnedBoundedFetchOptions,
): Promise<Response> {
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_REST_RESPONSE_MAX_BYTES;
  const maxResponseChunks = options.maxResponseChunks ?? DEFAULT_REST_RESPONSE_MAX_CHUNKS;
  return boundedFetch(input, init, {
    timeoutMs: options.timeoutMs,
    maxResponseBytes,
    maxResponseChunks,
    timeoutMessage: "REST request deadline expired",
    cancellationMessage: "REST request cancelled",
    invalidBoundsError: () =>
      new ElizaError("REST hop bounds must be timer-safe integers", {
        code: "INVALID_CLOUD_REST_BOUNDS",
        context: { timeoutMs: options.timeoutMs, maxResponseBytes, maxResponseChunks },
      }),
    responseTooLargeError: (context) =>
      new ElizaError("REST response exceeds its bounded-body contract", {
        code: "CLOUD_REST_RESPONSE_TOO_LARGE",
        context,
        severity: "ephemeral",
      }),
  });
}
