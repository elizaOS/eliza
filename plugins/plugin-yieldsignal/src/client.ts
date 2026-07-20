import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { wrapFetchWithPayment } from "@x402/fetch";

const YIELDSIGNAL_BASE_URL = "https://yieldsignal.vercel.app";

export type YieldSignalAsset = "USDC" | "WETH";

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
export async function fetchYieldSignal(asset: YieldSignalAsset): Promise<unknown> {
  const client = new CdpX402Client();
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);
  const res = await fetchWithPayment(`${YIELDSIGNAL_BASE_URL}/signal/${asset.toLowerCase()}-base-yield`);
  if (!res.ok) {
    throw new Error(`YieldSignal request failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}
