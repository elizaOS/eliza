/**
 * Minimal DFlow Trade API client (GET /order).
 * Docs: https://pond.dflow.net/resources/trading-api/order/order
 */

import type { DflowTradeConfig } from "../config.js";

export type DflowOrderRequest = {
  inputMint: string;
  outputMint: string;
  amount: string; // atomic
  userPublicKey?: string;
  slippageBps?: string;
  prioritizationFeeLamports?: string;
  onlyDirectRoutes?: boolean;
};

export type DflowOrderResponse = {
  inputMint?: string;
  outputMint?: string;
  inAmount?: string;
  outAmount?: string;
  otherAmountThreshold?: string;
  priceImpactPct?: string | number;
  slippageBps?: number | string;
  routePlan?: unknown;
  transaction?: string;
  lastValidBlockHeight?: number;
  prioritizationFeeLamports?: number | string;
  contextSlot?: number;
  error?: string;
  message?: string;
  [key: string]: unknown;
};

export class DflowClient {
  constructor(private cfg: DflowTradeConfig) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.cfg.apiKey) {
      h["x-api-key"] = this.cfg.apiKey;
    }
    return h;
  }

  async getOrder(req: DflowOrderRequest): Promise<DflowOrderResponse> {
    const params = new URLSearchParams();
    params.set("inputMint", req.inputMint);
    params.set("outputMint", req.outputMint);
    params.set("amount", req.amount);
    if (req.userPublicKey) params.set("userPublicKey", req.userPublicKey);
    params.set(
      "slippageBps",
      req.slippageBps || this.cfg.defaultSlippageBps || "auto",
    );
    params.set(
      "prioritizationFeeLamports",
      req.prioritizationFeeLamports ||
        this.cfg.prioritizationFeeLamports ||
        "auto",
    );
    if (req.onlyDirectRoutes) params.set("onlyDirectRoutes", "true");

    const url = `${this.cfg.tradeApiUrl.replace(/\/$/, "")}/order?${params}`;
    const res = await fetch(url, { headers: this.headers() });
    const text = await res.text();
    let body: DflowOrderResponse;
    try {
      body = JSON.parse(text) as DflowOrderResponse;
    } catch {
      throw new Error(
        `DFlow /order non-JSON (${res.status}): ${text.slice(0, 200)}`,
      );
    }
    if (!res.ok) {
      const msg =
        body.message ||
        body.error ||
        text.slice(0, 300) ||
        `HTTP ${res.status}`;
      throw new Error(`DFlow /order failed (${res.status}): ${msg}`);
    }
    return body;
  }
}

export function formatQuote(
  order: DflowOrderResponse,
  meta: { inSymbol: string; outSymbol: string; humanIn: string },
): string {
  const out = order.outAmount ?? "?";
  const impact = order.priceImpactPct ?? "?";
  const slip = order.slippageBps ?? "?";
  const hasTx = Boolean(order.transaction);
  return [
    `DFlow quote: ${meta.humanIn} ${meta.inSymbol} → ${meta.outSymbol}`,
    `  inAmount (atomic): ${order.inAmount ?? meta.humanIn}`,
    `  outAmount (atomic): ${out}`,
    `  otherAmountThreshold: ${order.otherAmountThreshold ?? "n/a"}`,
    `  priceImpactPct: ${impact}`,
    `  slippageBps: ${slip}`,
    `  transaction attached: ${hasTx ? "yes" : "no (quote-only)"}`,
    hasTx
      ? "  Sign+broadcast requires SOLANA_TRADE_LIVE=true + wallet key + HELIUS_RPC_URL."
      : "  Pass wallet for a signable tx, or use DFLOW_SWAP with live flags.",
  ].join("\n");
}
