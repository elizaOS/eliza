/**
 * Constrains the stability-attempt parent process to loopback transports while
 * retaining every admitted and rejected fetch decision for attempt evidence.
 */

import { isIP } from "node:net";
import { ElizaError } from "@elizaos/core/errors";

export interface StabilityParentNetworkEntry {
  origin: string;
  method: string;
  allowed: boolean;
}

function requestMethod(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
): string {
  return init?.method ?? (input instanceof Request ? input.method : "GET");
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
  const nativePreconnect = nativeFetch.preconnect;
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
        method: requestMethod(input, init),
        allowed,
      });
      if (!allowed) throw new Error(`unexpected egress blocked: ${url.origin}`);
      const response = await nativeFetch(input, {
        ...init,
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("loopback redirect omitted Location");
        const target = new URL(location, url);
        const targetAllowed = isLoopbackHostname(target.hostname);
        ledger.push({
          origin: target.origin,
          method: requestMethod(input, init),
          allowed: targetAllowed,
        });
        if (!targetAllowed) {
          throw new Error(
            `unexpected redirect egress blocked: ${target.origin}`,
          );
        }
        throw new Error(`loopback redirect blocked: ${target.origin}`);
      }
      return response;
    },
    {
      preconnect:
        typeof nativePreconnect === "function"
          ? (...args: Parameters<typeof nativePreconnect>) => {
              const url = new URL(args[0]);
              const allowed = isLoopbackHostname(url.hostname);
              ledger.push({
                origin: url.origin,
                method: "PRECONNECT",
                allowed,
              });
              if (!allowed) {
                throw new ElizaError(
                  `unexpected preconnect egress blocked: ${url.origin}`,
                  {
                    code: "STABILITY_PARENT_PRECONNECT_DENIED",
                    context: { origin: url.origin },
                  },
                );
              }
              return nativePreconnect.apply(nativeFetch, args);
            }
          : nativePreconnect,
    },
  );
}
