/**
 * Protocol negotiation.
 *
 * x402 signals itself with:    `Accept: application/x402+json`  OR PAYMENT-SIGNATURE header present
 * MPP signals itself with:     `Authorization: Payment ...`    OR `Accept: application/mpp+json`
 * AP2 signals itself with:     `X-AP2-Mandate: <jwt-vc>`       (Google's proposed header)
 * A2A signals itself with:     A2A JSON-RPC envelope in the body (method: "tasks/send")
 *
 * If nothing is set, we default to x402 — it's the most widely adopted.
 *
 * MPP is backwards-compatible with x402 at the frame level, so an MPP client
 * pointed at our x402 endpoint will be served a translated challenge.
 */

import type { Context } from "hono";

export type Protocol = "x402" | "mpp" | "ap2" | "a2a";

export function negotiate(c: Context): Protocol {
  const accept = c.req.header("accept") ?? "";
  const auth = c.req.header("authorization") ?? "";
  const paymentSig = c.req.header("payment-signature") ?? c.req.header("x-payment");
  const mandate = c.req.header("x-ap2-mandate");

  if (mandate) return "ap2";
  if (auth.toLowerCase().startsWith("payment ") || accept.includes("application/mpp+json")) {
    return "mpp";
  }
  // A2A is detected by body shape, not header — the caller should route
  // /a2a/:id/* directly to the A2A handler. If they miss it, default to x402.
  if (paymentSig || accept.includes("application/x402+json")) return "x402";

  return "x402";
}

/** Build headers that advertise all supported protocols on the 402 response. */
export function advertiseProtocols(): Record<string, string> {
  return {
    "accept-payment": "x402, mpp, ap2, a2a",
    "x-payment-protocols": "x402,mpp,ap2,a2a",
  };
}
