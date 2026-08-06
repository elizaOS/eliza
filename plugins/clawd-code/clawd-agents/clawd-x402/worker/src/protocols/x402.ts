/**
 * x402 protocol framing.
 *
 * A server returns `402 Payment Required` with:
 *   PAYMENT-REQUIRED: <base64-json of PaymentRequirement[]>
 *
 * The client pays and retries with:
 *   PAYMENT-SIGNATURE: <base64 signed transaction>
 *
 * On success, the server returns the resource + a confirmation header:
 *   PAYMENT-RESPONSE: <base64-json of { signature, network }>
 */

import type { Context } from "hono";
import type { Env, SolanaPaymentRequirement } from "../types";
import { buildChallenge, encodeChallenge, decodeSignedTransaction, verifyPayment, settlePayment } from "../solana/x402";

export async function respondWithChallenge(
  c: Context<{ Bindings: Env }>,
  challenge: SolanaPaymentRequirement,
): Promise<Response> {
  return new Response(
    JSON.stringify({
      x402Version: 1,
      accepts: [challenge],
      error: "Payment Required",
    }),
    {
      status: 402,
      headers: {
        "content-type": "application/json",
        "payment-required": encodeChallenge(challenge),
      },
    },
  );
}

export async function buildSolanaChallenge(
  env: Env,
  resource: string,
  description: string,
  payTo: string,
  asset: string,
  amount: bigint,
  decimals: number,
  memo?: string,
): Promise<SolanaPaymentRequirement> {
  return buildChallenge(env, { resource, description, payTo, asset, amount, decimals, memo });
}

export interface PaymentResult {
  signature: string;
  payer: string;
  amount: bigint;
  asset: string;
}

/**
 * Handle a client-submitted payment (from PAYMENT-SIGNATURE header).
 * Returns the settled result, or throws with a reason the caller can map to 402.
 */
export async function handlePayment(
  env: Env,
  paymentHeader: string,
  challenge: SolanaPaymentRequirement,
  expectedPayer?: string,
): Promise<PaymentResult> {
  const tx = decodeSignedTransaction(paymentHeader);
  const verify = await verifyPayment(env, tx, challenge);
  if (!verify.valid || !verify.payer) {
    throw new Error(`verify failed: ${verify.reason}`);
  }
  if (expectedPayer && verify.payer !== expectedPayer) {
    throw new Error("payer mismatch");
  }

  const signature = await settlePayment(env, tx);

  return {
    signature,
    payer: verify.payer,
    amount: BigInt(challenge.maxAmountRequired),
    asset: challenge.asset,
  };
}

export function paymentResponseHeader(result: PaymentResult, network: string): Record<string, string> {
  return {
    "payment-response": btoa(
      JSON.stringify({
        signature: result.signature,
        payer: result.payer,
        amount: result.amount.toString(),
        asset: result.asset,
        network,
      }),
    ),
  };
}
