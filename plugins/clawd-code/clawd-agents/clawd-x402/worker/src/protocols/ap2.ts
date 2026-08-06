/**
 * AP2 (Agent Payments Protocol) adapter.
 *
 * AP2 is Google's proposed protocol for agent-to-merchant payments. Its core primitive
 * is the **Intent Mandate** — a W3C Verifiable Credential signed by the user (or their
 * delegated agent) that authorises a specific spend up to a maximum amount.
 *
 * Our role: accept a valid mandate at request time, then settle the actual transfer on
 * Solana. Two flows are supported:
 *
 *   A) User-held wallet flow:
 *      Client sends `X-AP2-Mandate: <jwt-vc>`. We verify the VC and return a 402 with a
 *      Solana x402 challenge sized to the mandate's maxAmount. Client pays from their
 *      wallet. The mandate is attached to the settlement receipt for auditability.
 *
 *   B) Custodial flow:
 *      Client sends `X-AP2-Mandate: <jwt-vc>` AND the mandate names us (the ClawdRouter
 *      operator) as the disbursing custodian. We sign a Solana transfer ourselves,
 *      using OPERATOR_KEYPAIR, and serve the resource in the same response.
 *      Useful for agents that don't hold Solana but have a funded custodial account.
 *
 * VC verification is JWT-VC (RFC 7519 + VC Data Model v2). We use `jose` with the
 * AP2_VERIFIER_JWK public key — this should be the key of the issuer your system
 * trusts (typically the user's agent-of-record or a shared verifier service).
 *
 * Reference: https://github.com/google-agentic-commerce/ap2
 */

import { importJWK, jwtVerify } from "jose";
import type { Context } from "hono";

import type { Env, AP2IntentMandate, SolanaPaymentRequirement } from "../types";
import { handlePayment as handleX402Payment, PaymentResult } from "./x402";

export interface VerifiedMandate {
  valid: true;
  payload: NonNullable<AP2IntentMandate["payload"]>;
}

export interface InvalidMandate {
  valid: false;
  reason: string;
}

/** Verify a JWT-VC mandate. Returns the decoded payload if valid. */
export async function verifyMandate(
  env: Env,
  jwtVc: string,
  expectedAudience: string,
  expectedResource: string,
): Promise<VerifiedMandate | InvalidMandate> {
  if (!env.AP2_VERIFIER_JWK) {
    return { valid: false, reason: "AP2_VERIFIER_JWK not configured" };
  }

  try {
    const jwk = JSON.parse(env.AP2_VERIFIER_JWK);
    const key = await importJWK(jwk);
    const { payload } = await jwtVerify(jwtVc, key, {
      audience: expectedAudience,
    });

    // AP2 mandates carry a `vc` claim with the full credential; fields we care about
    // are promoted to the top-level JWT payload by most issuers.
    const p = payload as Record<string, unknown>;
    const iss = typeof p.iss === "string" ? p.iss : "";
    const sub = typeof p.sub === "string" ? p.sub : "";
    const aud = typeof p.aud === "string" ? p.aud : "";
    const exp = typeof p.exp === "number" ? p.exp : 0;
    const maxAmount = typeof p.maxAmount === "string" ? p.maxAmount : String(p.maxAmount ?? "");
    const asset = typeof p.asset === "string" ? p.asset : "";
    const resource = typeof p.resource === "string" ? p.resource : "";

    if (!iss || !sub || !aud || !exp || !maxAmount || !asset || !resource) {
      return { valid: false, reason: "mandate missing required claims" };
    }
    if (exp * 1000 < Date.now()) {
      return { valid: false, reason: "mandate expired" };
    }
    if (resource !== expectedResource) {
      return { valid: false, reason: `mandate resource mismatch: got ${resource} want ${expectedResource}` };
    }

    return {
      valid: true,
      payload: { iss, sub, aud, exp, maxAmount, asset, resource },
    };
  } catch (e) {
    return { valid: false, reason: `mandate verify failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Return a 402 response that asks for an AP2 mandate.
 *
 * The challenge advertises: "send an X-AP2-Mandate header whose VC authorises
 * at least `amount` of `asset` for `resource`, with audience = this gateway."
 */
export function respondWithAp2Challenge(
  c: Context<{ Bindings: Env }>,
  challenge: SolanaPaymentRequirement,
): Response {
  return new Response(
    JSON.stringify({
      type: "ap2-mandate-required",
      audience: new URL(c.req.url).origin,
      maxAmount: challenge.maxAmountRequired,
      asset: challenge.asset,
      resource: challenge.resource,
      settlement: {
        scheme: "exact",
        network: challenge.network,
        recipient: challenge.payTo,
        decimals: challenge.extra.decimals,
      },
    }),
    {
      status: 402,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `AP2-Mandate audience="${new URL(c.req.url).origin}", resource="${challenge.resource}"`,
      },
    },
  );
}

/**
 * Flow A — user-held wallet: verify the mandate, then require a Solana x402
 * payment from the user. Returns the settlement once complete.
 */
export async function handleAp2UserFlow(
  env: Env,
  mandateJwt: string,
  paymentHeader: string,
  challenge: SolanaPaymentRequirement,
  expectedAudience: string,
  expectedPayer?: string,
): Promise<{ payment: PaymentResult; mandate: VerifiedMandate["payload"] }> {
  const v = await verifyMandate(env, mandateJwt, expectedAudience, challenge.resource);
  if (!v.valid) throw new Error(`AP2 mandate invalid: ${v.reason}`);

  if (BigInt(v.payload.maxAmount) < BigInt(challenge.maxAmountRequired)) {
    throw new Error(`AP2 mandate maxAmount too low`);
  }
  if (v.payload.asset !== challenge.asset) {
    throw new Error(`AP2 mandate asset mismatch`);
  }

  const payment = await handleX402Payment(env, paymentHeader, challenge, expectedPayer);
  return { payment, mandate: v.payload };
}

/**
 * Flow B — custodial: the mandate names us as custodian, so we sign a Solana
 * transfer on behalf of the user. Deferred until OPERATOR_KEYPAIR signing is
 * wired; see solana/x402.ts#operatorSignedTransfer.
 */
export async function handleAp2CustodialFlow(
  _env: Env,
  _mandateJwt: string,
  _challenge: SolanaPaymentRequirement,
): Promise<PaymentResult> {
  throw new Error("AP2 custodial flow: pending operator signing integration");
}

export function ap2ReceiptHeader(
  result: PaymentResult,
  mandate: VerifiedMandate["payload"],
  network: string,
): Record<string, string> {
  return {
    "payment-receipt": btoa(
      JSON.stringify({
        protocol: "ap2",
        mandate: { iss: mandate.iss, sub: mandate.sub, exp: mandate.exp },
        signature: result.signature,
        payer: result.payer,
        amount: result.amount.toString(),
        asset: result.asset,
        network,
      }),
    ),
  };
}
