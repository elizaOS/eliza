/**
 * x402 facilitator — Solana-native equivalent of https://x402.org/facilitator.
 *
 * Exposes three endpoints that any x402 server can point at via `facilitator: { url }`:
 *
 *   POST /facilitator/verify   — checks a submitted PAYMENT-SIGNATURE is valid
 *   POST /facilitator/settle   — broadcasts the tx on Solana, returns the signature
 *   GET  /facilitator/supported — lists networks and assets this facilitator handles
 *
 * This is the Solana counterpart to the EVM facilitator Coinbase operates.
 */

import { Hono } from "hono";
import type { Env } from "../types";
import {
  decodeChallenge,
  decodeSignedTransaction,
  verifyPayment,
  settlePayment,
} from "./x402";
import { detectPToken, SPL_TOKEN_PROGRAM_ID } from "./p-token";

export const facilitator = new Hono<{ Bindings: Env }>();

facilitator.get("/supported", async (c) => {
  const pToken = await detectPToken(c.env);
  const tokenPrograms = [
    { id: "spl", programId: SPL_TOKEN_PROGRAM_ID.toBase58() },
  ];
  if (pToken.active) {
    tokenPrograms.push({ id: "p-token", programId: pToken.programId });
  }

  return c.json({
    networks: [c.env.NETWORK],
    schemes: ["exact"],
    tokenPrograms,
    assets: [
      { mint: c.env.USDC_MINT, symbol: "USDC", decimals: 6, tokenPrograms: tokenPrograms.map((p) => p.id) },
      { mint: c.env.CLAWD_MINT, symbol: "CLAWD", decimals: 9, tokenPrograms: tokenPrograms.map((p) => p.id) },
    ],
  });
});

/**
 * POST /verify
 * body: { paymentHeader: string, requirement: <base64 challenge> }
 *
 * Returns:
 *   { isValid: true, payer: "<base58>" } — ok to serve the resource
 *   { isValid: false, invalidReason: "..." } — reject
 */
facilitator.post("/verify", async (c) => {
  const body = await c.req.json<{ paymentHeader: string; requirement: string }>();
  if (!body.paymentHeader || !body.requirement) {
    return c.json({ isValid: false, invalidReason: "missing fields" }, 400);
  }

  const req = decodeChallenge(body.requirement);
  const tx = decodeSignedTransaction(body.paymentHeader);

  const result = await verifyPayment(c.env, tx, req);
  if (!result.valid) {
    return c.json({ isValid: false, invalidReason: result.reason });
  }
  return c.json({ isValid: true, payer: result.payer, signature: result.signature });
});

/**
 * POST /settle
 * body: { paymentHeader: string, requirement: <base64 challenge> }
 *
 * Returns:
 *   { success: true, txHash: "<signature>", networkId: "solana-mainnet" }
 */
facilitator.post("/settle", async (c) => {
  const body = await c.req.json<{ paymentHeader: string; requirement: string }>();
  if (!body.paymentHeader || !body.requirement) {
    return c.json({ success: false, error: "missing fields" }, 400);
  }

  const req = decodeChallenge(body.requirement);
  const tx = decodeSignedTransaction(body.paymentHeader);

  // Re-verify before broadcasting. Cheap and protects against settle-without-verify.
  const verification = await verifyPayment(c.env, tx, req);
  if (!verification.valid) {
    return c.json({ success: false, error: verification.reason }, 400);
  }

  try {
    const signature = await settlePayment(c.env, tx);
    return c.json({
      success: true,
      txHash: signature,
      networkId: c.env.NETWORK,
      payer: verification.payer,
    });
  } catch (e) {
    return c.json({ success: false, error: e instanceof Error ? e.message : String(e) }, 502);
  }
});
