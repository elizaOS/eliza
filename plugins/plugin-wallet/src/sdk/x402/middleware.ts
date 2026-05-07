// [MAX-ADDED] x402 Middleware — wraps fetch/axios to be x402-aware

import type { AgentWallet } from "../wallet-core.js";
import { X402Client } from "./client.js";
import type { X402ClientConfig } from "./types.js";

/**
 * [MAX-ADDED] Create an x402-aware HTTP client.
 *
 * Usage:
 *   const client = createX402Client(wallet, { globalDailyLimit: 10_000_000n });
 *   const response = await client.fetch('https://api.example.com/data');
 *   // If the endpoint returns 402, payment is handled automatically
 *
 * @param wallet - AgentWallet instance from createWallet()
 * @param config - Optional x402 client configuration
 * @returns X402Client with .fetch() method and budget controls
 */
export function createX402Client(
  wallet: AgentWallet,
  config?: X402ClientConfig,
): X402Client {
  return new X402Client(wallet, config);
}

/**
 * [MAX-ADDED] Create an x402-aware fetch function (drop-in replacement).
 *
 * Usage:
 *   const x402Fetch = createX402Fetch(wallet);
 *   const response = await x402Fetch('https://api.example.com/data');
 *
 * @param wallet - AgentWallet instance from createWallet()
 * @param config - Optional x402 client configuration
 * @returns A fetch-compatible function that handles 402 payments
 */
export function createX402Fetch(
  wallet: AgentWallet,
  config?: X402ClientConfig,
): typeof globalThis.fetch {
  const client = new X402Client(wallet, config);
  return (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    return client.fetch(url, init);
  };
}

/**
 * [MAX-ADDED] Wrap an existing fetch-like function to be x402-aware.
 * Useful for wrapping custom HTTP clients or test mocks.
 *
 * @param fetchFn - The original fetch function to wrap
 * @param wallet - AgentWallet instance
 * @param config - Optional x402 client configuration
 */
export function wrapWithX402(
  fetchFn: typeof globalThis.fetch,
  wallet: AgentWallet,
  config?: X402ClientConfig,
): typeof globalThis.fetch {
  const wrappedClient = new X402Client(wallet, config);

  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    const response = await fetchFn(input, init);

    if (response.status !== 402) {
      return response;
    }

    // Parse and handle 402 via the client
    const paymentRequired = await wrappedClient.parse402Response(response);
    if (!paymentRequired) return response;

    const selected = wrappedClient.selectPaymentOption(paymentRequired.accepts);
    if (!selected) return response;

    // Use the client's fetch for retry (which calls globalThis.fetch)
    return wrappedClient.fetch(url, init);
  };
}
