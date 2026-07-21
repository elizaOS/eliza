import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { wrapFetchWithPayment } from "@x402/fetch";

const YIELDSIGNAL_BASE_URL = "https://yieldsignal.vercel.app";

export type YieldSignalAsset = "USDC" | "WETH";

/** One protocol's reading inside a signal response. */
export interface YieldSignalRate {
  protocol: string;
  apyBps: number;
  weightedApyBps: number;
  source: string;
  asOf: string;
}

/**
 * Shape of a YieldSignal response body. Typed concretely (rather than
 * `unknown`) so the action can hand it to elizaOS's `ActionResult.data`
 * (`ProviderDataRecord`) without a cast.
 */
export interface YieldSignalResponse {
  asset: YieldSignalAsset;
  bestProtocol: string;
  gapBps: number;
  rates: YieldSignalRate[];
  asOf: string;
}

/**
 * Real-time, risk-weighted USDC/WETH lending APY across Aave, Compound,
 * Morpho, Moonwell, Euler and Fluid on Base — sold per-call via x402
 * ($0.01), paid here through the agent's own CDP wallet
 * (CDP_API_KEY_ID/CDP_API_KEY_SECRET/CDP_WALLET_SECRET env vars) rather than
 * routing through elizaOS's own `plugin-x402` (which is seller-side
 * middleware for protecting THIS agent's own routes, not a buyer-side client
 * for paying external x402 APIs). Every response is signed (EIP-712) by the
 * payment-receiving address, which also holds an ERC-8004 agent identity
 * (`/agent-card.json`) and periodically publishes EAS attestations of past
 * readings on Base mainnet (`/track-record`). See https://yieldsignal.vercel.app.
 */
export async function fetchYieldSignal(
  asset: YieldSignalAsset,
): Promise<YieldSignalResponse> {
  const client = new CdpX402Client();
  // `CdpX402Client` extends `x402Client`, which is exactly what
  // `wrapFetchWithPayment` accepts. The narrow here only exists because in a
  // workspace install the two packages can resolve *different copies* of
  // `@x402/core` (e.g. bun linking cdp-sdk's `@x402/core` to an older minor
  // than the one @x402/fetch pulls), which makes the two `x402Client` types
  // structurally diverge even though `CdpX402Client` fulfils the payment
  // contract at runtime (verified end-to-end against production). Kept to this
  // single boundary and typed via the function's own parameter type — not `any`.
  const fetchWithPayment = wrapFetchWithPayment(
    fetch,
    client as unknown as Parameters<typeof wrapFetchWithPayment>[1],
  );
  const res = await fetchWithPayment(
    `${YIELDSIGNAL_BASE_URL}/signal/${asset.toLowerCase()}-base-yield`,
  );
  if (!res.ok) {
    throw new Error(
      `YieldSignal request failed: ${res.status} ${await res.text()}`,
    );
  }
  return res.json() as Promise<YieldSignalResponse>;
}
