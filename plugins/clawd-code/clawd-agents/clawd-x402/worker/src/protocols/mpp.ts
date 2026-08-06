/**
 * MPP (Machine Payments Protocol) adapter.
 *
 * MPP uses the standard HTTP auth scheme framing:
 *   WWW-Authenticate: Payment <params>
 *   Authorization: Payment <params>
 *
 * Per the spec, MPP's `charge` intent maps directly onto x402's `exact` flow.
 * We translate the outbound challenge to MPP syntax and accept inbound
 * Authorization: Payment headers that carry either a Tempo stablecoin
 * signature OR a Solana signed transaction (our extension).
 *
 * Reference: https://mpp.dev  — IETF draft Payment HTTP Authentication Scheme.
 */

import type { Context } from "hono";
import type { Env, SolanaPaymentRequirement } from "../types";
import { handlePayment as handleX402Payment, PaymentResult } from "./x402";

/**
 * Build a 402 response with an MPP-formatted WWW-Authenticate challenge.
 *
 * Example header emitted:
 *   WWW-Authenticate: Payment realm="clawdrouter",
 *     intent="charge",
 *     methods="solana-exact, tempo, stripe-spt",
 *     amount="0.01", currency="USDC",
 *     recipient="<base58>", asset="<mint>",
 *     nonce="<recentBlockhash>"
 */
export function respondWithMppChallenge(
  c: Context<{ Bindings: Env }>,
  challenge: SolanaPaymentRequirement,
): Response {
  const params = [
    `realm="clawdrouter"`,
    `intent="charge"`,
    `methods="solana-exact"`,
    `amount="${challenge.maxAmountRequired}"`,
    `asset="${challenge.asset}"`,
    `recipient="${challenge.payTo}"`,
    `decimals="${challenge.extra.decimals}"`,
    `nonce="${challenge.extra.recentBlockhash ?? ""}"`,
    `resource="${challenge.resource}"`,
    `description="${challenge.description}"`,
  ].join(", ");

  return new Response(
    JSON.stringify({
      type: "payment-required",
      intent: "charge",
      methods: [
        {
          method: "solana-exact",
          network: challenge.network,
          recipient: challenge.payTo,
          asset: challenge.asset,
          amount: challenge.maxAmountRequired,
          decimals: challenge.extra.decimals,
          nonce: challenge.extra.recentBlockhash,
        },
      ],
    }),
    {
      status: 402,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Payment ${params}`,
      },
    },
  );
}

/**
 * Parse an incoming Authorization: Payment header into a solana-exact
 * signed-transaction blob the x402 path can consume.
 *
 * Accepted forms:
 *   Authorization: Payment method=solana-exact, tx="<base64>"
 *   Authorization: Payment method=solana-exact, signature="<base64>"  (alias)
 */
export function extractSolanaBlob(authHeader: string): string | null {
  if (!authHeader.toLowerCase().startsWith("payment ")) return null;
  const params = parseAuthParams(authHeader.slice("payment ".length));
  if (params.method && params.method !== "solana-exact") return null;
  return params.tx ?? params.signature ?? null;
}

function parseAuthParams(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  // simple tokenizer — good enough for well-formed MPP headers
  const re = /(\w+)="?([^",]+)"?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    out[m[1]] = m[2];
  }
  return out;
}

export async function handleMppPayment(
  env: Env,
  authHeader: string,
  challenge: SolanaPaymentRequirement,
  expectedPayer?: string,
): Promise<PaymentResult> {
  const blob = extractSolanaBlob(authHeader);
  if (!blob) {
    // TODO: if method=tempo, verify via Tempo SDK + mirror the charge with an operator-signed
    // Solana transfer to close the loop. Deferred to the MPP integration pass.
    throw new Error("MPP: only solana-exact method is implemented in this build");
  }
  return handleX402Payment(env, blob, challenge, expectedPayer);
}

export function mppReceiptHeader(result: PaymentResult, network: string): Record<string, string> {
  return {
    "payment-receipt": btoa(
      JSON.stringify({
        method: "solana-exact",
        signature: result.signature,
        payer: result.payer,
        amount: result.amount.toString(),
        asset: result.asset,
        network,
      }),
    ),
  };
}
