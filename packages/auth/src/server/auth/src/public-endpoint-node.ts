import { lookup as dnsLookup } from "node:dns";
import type { LookupFunction } from "node:net";
import { assertPublicInternetAddress } from "./public-endpoint";

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
  return (hostname, options, callback) => {
    if (options.all) {
      dnsLookup(
        hostname,
        {
          all: true,
          family: options.family,
          hints: options.hints,
          verbatim: true,
        },
        (error, addresses) => {
          if (error) {
            callback(error, addresses);
            return;
          }
          try {
            if (addresses.length === 0)
              throw new Error(`${resource} host did not resolve`);
            for (const { address, family } of addresses) {
              assertPublicInternetAddress(address, family, resource);
            }
            callback(null, addresses);
          } catch (destinationError) {
            callback(destinationError as NodeJS.ErrnoException, addresses);
          }
        },
      );
      return;
    }

    dnsLookup(
      hostname,
      {
        all: false,
        family: options.family,
        hints: options.hints,
        verbatim: true,
      },
      (error, address, family) => {
        if (error) {
          callback(error, address, family);
          return;
        }
        try {
          assertPublicInternetAddress(address, family, resource);
          callback(null, address, family);
        } catch (destinationError) {
          callback(destinationError as NodeJS.ErrnoException, address, family);
        }
      },
    );
  };
}
