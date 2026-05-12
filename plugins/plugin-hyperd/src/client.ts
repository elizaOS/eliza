/**
 * HyperdClient — x402-aware HTTP client for hyperD's paid endpoints.
 *
 * Wraps globalThis.fetch with @x402/fetch's wrapFetchWithPaymentFromConfig.
 * Each request that returns 402 is automatically signed (EIP-3009 USDC
 * transfer authorization on Base) and retried. Settlement happens through
 * Coinbase's facilitator in ~2 seconds.
 *
 * One client instance per plugin lifetime; the underlying fetch wrap is
 * idempotent under reuse.
 */

import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import type { HyperdConfig } from "./config.js";

export type PaidFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export class HyperdClient {
  readonly apiBase: string;
  readonly maxUsdcPerCall: number;
  private readonly paidFetch: PaidFetch;

  constructor(config: HyperdConfig) {
    this.apiBase = config.apiBase;
    this.maxUsdcPerCall = config.maxUsdcPerCall;

    const account = privateKeyToAccount(config.buyerPrivateKey);
    const wrapped = wrapFetchWithPaymentFromConfig(globalThis.fetch, {
      schemes: [
        {
          network: "eip155:8453", // Base Mainnet
          client: new ExactEvmScheme(account),
        },
      ],
    });
    this.paidFetch = wrapped as PaidFetch;
  }

  /**
   * Make a paid GET against a hyperD endpoint.
   *
   * @param path  Path beginning with `/api/` (e.g. `/api/risk/wallet`).
   * @param query Query params (URLSearchParams-compatible record). Values are
   *              coerced to strings. Keys with undefined values are dropped.
   * @returns Parsed JSON response. Throws on non-2xx after payment retry.
   */
  async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(path.startsWith("/") ? path : `/${path}`, this.apiBase);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    const res = await this.paidFetch(url.toString(), { method: "GET" });

    if (!res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = await res.text().catch(() => "");
      }
      const msg = typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
      throw new HyperdRequestError(msg, res.status, body);
    }

    return (await res.json()) as T;
  }
}

export class HyperdRequestError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "HyperdRequestError";
    this.status = status;
    this.body = body;
  }
}
