import { createWalletClient, http, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

// ─── Public constants ─────────────────────────────────────────────────────────

export const EZPATH_API     = "https://ezpath.myezverse.xyz/api/v1/quote";
export const USDC_BASE      = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export const TIER_ATOMIC = {
  basic:         30000n,   // 0.03 USDC
  resilient:     100000n,  // 0.10 USDC
  institutional: 500000n,  // 0.50 USDC
} as const;

export type Tier = keyof typeof TIER_ATOMIC;

// ─── Response types ───────────────────────────────────────────────────────────

export interface RoutingMetadata {
  execution_mode: "direct" | "concurrent_race" | "emergency_onchain_fallback";
  winner: "0x" | "paraswap" | "aerodrome" | "uniswap_v3_onchain";
  race_comparison?: {
    lane_1_aggregator_out: string;
    lane_2_aerodrome_out:  string;
  };
}

export interface QuoteResult {
  request_id:       string;
  sellToken:        string;
  buyToken:         string;
  sellAmount:       string;
  buyAmount:        string;
  price:            string;
  sources:          Array<{ name: string; proportion: string }>;
  routingEngine:    string;
  tier:             Tier;
  routing_metadata: RoutingMetadata;
  settlement_tx?:   string; // X-Settlement-Tx header, if settlement was confirmed
}

interface PaymentRequiredBody {
  status: "payment_required";
  tiers: Record<Tier, { min_atomic: string; min_usdc: number; description: string }>;
}

// ─── X402 auto-negotiation ────────────────────────────────────────────────────

export async function getQuote(params: {
  sellToken:          string;
  buyToken:           string;
  sellAmount:         string;
  slippagePercentage?: number;
  tier:               Tier;
  privateKey:         `0x${string}`;
}): Promise<QuoteResult> {
  const { sellToken, buyToken, sellAmount, slippagePercentage, tier, privateKey } = params;

  const url = new URL(EZPATH_API);
  url.searchParams.set("sellToken",  sellToken);
  url.searchParams.set("buyToken",   buyToken);
  url.searchParams.set("sellAmount", sellAmount);
  if (slippagePercentage !== undefined) {
    url.searchParams.set("slippagePercentage", String(slippagePercentage));
  }

  // ── Step 1: probe to read toll address from 402 headers (works even if address rotates)
  const probe = await fetch(url.toString());
  if (probe.status !== 402) {
    throw new Error(`ezpath: expected 402 negotiation response, got ${probe.status}`);
  }
  const tollAddress = probe.headers.get("X-402-Address");
  if (!tollAddress) throw new Error("ezpath: 402 response missing X-402-Address header");

  const probeBody = await probe.json() as PaymentRequiredBody;
  const tierInfo  = probeBody.tiers?.[tier];
  const valueAtomic = tierInfo ? BigInt(tierInfo.min_atomic) : TIER_ATOMIC[tier];

  // ── Step 2: sign EIP-3009 TransferWithAuthorization
  const account     = privateKeyToAccount(privateKey);
  const client      = createWalletClient({ account, chain: base, transport: http() });
  const validAfter  = 0n;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 300);
  const nonce       = toHex(crypto.getRandomValues(new Uint8Array(32)));

  const signature = await client.signTypedData({
    domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC_BASE as `0x${string}` },
    types: {
      TransferWithAuthorization: [
        { name: "from",        type: "address" },
        { name: "to",          type: "address" },
        { name: "value",       type: "uint256" },
        { name: "validAfter",  type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce",       type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from:        account.address,
      to:          tollAddress as `0x${string}`,
      value:       valueAtomic,
      validAfter,
      validBefore,
      nonce:       nonce as `0x${string}`,
    },
  });

  const paymentPayload = {
    x402Version: 1,
    scheme: "exact",
    network: "base",
    payload: {
      signature,
      authorization: {
        from:        account.address,
        to:          tollAddress,
        value:       valueAtomic.toString(),
        validAfter:  validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };

  // ── Step 3: retry with payment
  const res = await fetch(url.toString(), {
    headers: { "X-Payment": btoa(JSON.stringify(paymentPayload)) },
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error(`ezpath: ${res.status} ${errBody.status ?? "error"} — ${errBody.detail ?? JSON.stringify(errBody)}`);
  }

  const body         = await res.json() as Omit<QuoteResult, "settlement_tx">;
  const settlementTx = res.headers.get("X-Settlement-Tx") ?? undefined;
  return { ...body, settlement_tx: settlementTx };
}
