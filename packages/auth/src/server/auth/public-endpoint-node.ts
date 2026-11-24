import type { LookupFunction } from "node:net";
import {
  assertPublicInternetAddress,
  createValidatedLookup,
} from "@elizaos/core";

/**
 * Cloudflare's node:dns shim does not implement lookup(), and its node:https
 * client ignores the lookup option because it is backed by fetch(). Continuing
 * there would either break OIDC entirely or silently drop connect-time DNS
 * validation. Keep the boundary explicit and fail closed until the runtime
 * exposes a transport that can pin a validated address while retaining TLS SNI.
 */
export function assertPinnedDnsTransportSupported(resource: string): void {
  if (process.env.STEWARD_RUNTIME === "workers") {
    throw new Error(
      `${resource} requires connect-time DNS validation unavailable in Workers`,
    );
  }
}

/**
 * Node/Bun HTTPS lookup hook that validates the exact addresses handed to the
 * connector. Modern Node requests all candidates for Happy Eyeballs; honoring
 * `options.all` is essential both for compatibility and to prevent an unsafe
 * candidate from surviving alongside a public one.
 */
export function createPublicInternetLookup(resource: string): LookupFunction {
  return createValidatedLookup((address, family) => {
    assertPublicInternetAddress(address, family, resource);
  });
}
