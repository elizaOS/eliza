/**
 * Constrains the stability-attempt parent process to loopback transports while
 * retaining every admitted and rejected fetch decision for attempt evidence.
 */

import { isIP } from "node:net";

export interface StabilityParentNetworkEntry {
  origin: string;
  method: string;
  allowed: boolean;
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost") return true;
  const address =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  return (
    address === "::1" ||
    (isIP(address) === 4 && address.split(".", 1)[0] === "127")
  );
}

/** Creates a fetch wrapper that cannot directly reach any remote origin. */
export function createLoopbackOnlyFetch(
  nativeFetch: typeof globalThis.fetch,
  ledger: StabilityParentNetworkEntry[],
): typeof globalThis.fetch {
  return Object.assign(
    async (
      input: Parameters<typeof nativeFetch>[0],
      init?: Parameters<typeof nativeFetch>[1],
    ) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      const allowed = isLoopbackHostname(url.hostname);
      ledger.push({
        origin: url.origin,
        method:
          init?.method ?? (input instanceof Request ? input.method : "GET"),
        allowed,
      });
      if (!allowed) throw new Error(`unexpected egress blocked: ${url.origin}`);
      return nativeFetch(input, init);
    },
    { preconnect: nativeFetch.preconnect },
  );
}
