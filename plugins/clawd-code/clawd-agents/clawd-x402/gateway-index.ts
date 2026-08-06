/**
 * ClawdRouter gateway — entrypoint.
 *
 * Routes mounted:
 *   /facilitator/*            — Solana x402 facilitator (verify/settle/supported)
 *   /registry/:id             — read agent record + manifest
 *   /agents/:id/*             — payment-gated agent invocation (any protocol)
 *   /a2a/:id/.well-known/agent.json   — A2A agent card
 *   /a2a/:id                  — A2A JSON-RPC endpoint (payment-gated)
 *   /health                   — liveness
 */

import { Hono } from "hono";
import { cors } from "hono/cors";

import type { Env } from "./types";
import { facilitator } from "./solana/facilitator";
import { getAgent, methodHash, priceFor } from "./solana/registry";
import { holderDiscount, applyDiscount } from "./clawd";
import { computeSplit, receipt } from "./revenue";
import { pinJson } from "./ipfs/pinata";
import { negotiate, advertiseProtocols } from "./protocols/negotiate";
import {
  buildSolanaChallenge,
  respondWithChallenge,
  handlePayment,
  paymentResponseHeader,
} from "./protocols/x402";
import {
  respondWithMppChallenge,
  handleMppPayment,
  mppReceiptHeader,
} from "./protocols/mpp";
import {
  respondWithAp2Challenge,
  handleAp2UserFlow,
  ap2ReceiptHeader,
} from "./protocols/ap2";
import {
  fetchAgentCard,
  forwardA2ACall,
  priceForA2ACall,
  type A2ARequest,
} from "./protocols/a2a";

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors({ origin: "*", allowHeaders: ["*"], exposeHeaders: ["*"] }));

app.get("/health", (c) =>
  c.json({ ok: true, network: c.env.NETWORK, gateway: "x402.wtf" }),
);

app.route("/facilitator", facilitator);

/* ——— Registry read ——— */

app.get("/registry/:id", async (c) => {
  const id = c.req.param("id");
  const record = await getAgent(c.env, id);
  if (!record) return c.json({ error: "agent not found" }, 404);
  return c.json(record);
});

/* ——— A2A: agent card ——— */

app.get("/a2a/:id/.well-known/agent.json", async (c) => {
  const id = c.req.param("id");
  const record = await getAgent(c.env, id);
  if (!record) return c.json({ error: "agent not found" }, 404);
  try {
    const card = await fetchAgentCard(c.env, record);
    return c.json(card, 200, { "cache-control": "public, max-age=60" });
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

/* ——— A2A: JSON-RPC (payment-gated) ——— */

app.post("/a2a/:id", async (c) => gatedAgentCall(c, { mode: "a2a" }));

/* ——— Generic agent invocation (payment-gated) ——— */

app.all("/agents/:id/*", async (c) => gatedAgentCall(c, { mode: "passthrough" }));

/* ——— The payment-gated handler ——— */

interface GateOpts {
  mode: "a2a" | "passthrough";
}

async function gatedAgentCall(
  c: import("hono").Context<{ Bindings: Env }>,
  opts: GateOpts,
): Promise<Response> {
  const agentId = c.req.param("id");
  if (!agentId) return c.json({ error: "missing agent id" }, 400);

  const record = await getAgent(c.env, agentId);
  if (!record) return c.json({ error: "agent not found" }, 404);

  // Work out the method and base price.
  let methodName: string;
  let a2aRpc: A2ARequest | null = null;
  if (opts.mode === "a2a") {
    a2aRpc = (await c.req.json()) as A2ARequest;
    methodName = a2aRpc.method;
  } else {
    methodName = `${c.req.method} ${new URL(c.req.url).pathname.replace(`/agents/${agentId}`, "")}`;
  }

  const mh = await methodHash(methodName);
  const DEFAULT_PRICE = 10000n; // 0.01 USDC fallback in 6-decimal base units
  const basePrice =
    opts.mode === "a2a" && a2aRpc
      ? priceForA2ACall(record, a2aRpc, DEFAULT_PRICE)
      : priceFor(record, methodName, mh, DEFAULT_PRICE);

  // Negotiate the protocol the caller wants.
  const protocol = negotiate(c);
  if (protocol === "mpp" && !record.protocols.mpp) {
    return c.json({ error: "agent does not accept MPP" }, 406);
  }
  if (protocol === "ap2" && !record.protocols.ap2) {
    return c.json({ error: "agent does not accept AP2" }, 406);
  }
  if (protocol === "x402" && !record.protocols.x402) {
    return c.json({ error: "agent does not accept x402" }, 406);
  }

  // If the caller already attached payment, try to settle. Otherwise emit 402.
  const paymentSig = c.req.header("payment-signature") ?? c.req.header("x-payment");
  const authHeader = c.req.header("authorization") ?? "";
  const mandate = c.req.header("x-ap2-mandate") ?? "";

  const hasPayment =
    (protocol === "x402" && paymentSig) ||
    (protocol === "mpp" && authHeader.toLowerCase().startsWith("payment ")) ||
    (protocol === "ap2" && mandate && paymentSig);

  if (!hasPayment) {
    // Apply holder discount if we can identify the caller from the session/sender header.
    // For callers who haven't yet paid, we only know their identity if they declared it.
    const caller = c.req.header("x-payer") ?? "";
    const discount = caller ? await holderDiscount(c.env, caller) : { tier: 0 as const, bps: 0 };
    const effectivePrice = applyDiscount(basePrice, discount.bps);

    const challenge = await buildSolanaChallenge(
      c.env,
      new URL(c.req.url).pathname,
      `Call ${methodName} on agent ${agentId}`,
      c.env.TREASURY_OWNER,
      c.env.USDC_MINT,
      effectivePrice,
      6,
      `clawdrouter:${agentId}:${methodName}`,
    );

    const base =
      protocol === "mpp"
        ? respondWithMppChallenge(c, challenge)
        : protocol === "ap2"
          ? respondWithAp2Challenge(c, challenge)
          : await respondWithChallenge(c, challenge);

    const headers = new Headers(base.headers);
    for (const [k, v] of Object.entries(advertiseProtocols())) headers.set(k, v);
    if (discount.tier > 0) {
      headers.set("x-clawd-discount", `tier=${discount.tier}; bps=${discount.bps}`);
    }
    return new Response(base.body, { status: base.status, headers });
  }

  // Settle.
  const challenge = await buildSolanaChallenge(
    c.env,
    new URL(c.req.url).pathname,
    `Call ${methodName} on agent ${agentId}`,
    c.env.TREASURY_OWNER,
    c.env.USDC_MINT,
    basePrice,
    6,
    `clawdrouter:${agentId}:${methodName}`,
  );

  let paymentResult;
  try {
    if (protocol === "mpp") {
      paymentResult = await handleMppPayment(c.env, authHeader, challenge);
    } else if (protocol === "ap2") {
      const audience = new URL(c.req.url).origin;
      const flow = await handleAp2UserFlow(c.env, mandate, paymentSig!, challenge, audience);
      paymentResult = flow.payment;
    } else {
      paymentResult = await handlePayment(c.env, paymentSig!, challenge);
    }
  } catch (e) {
    return c.json({ error: `payment failed: ${e instanceof Error ? e.message : String(e)}` }, 402);
  }

  // Compute split + write receipt to IPFS.
  const split = computeSplit(c.env, record, paymentResult.amount);
  const rec = receipt(
    protocol,
    agentId,
    paymentResult.payer,
    paymentResult.signature,
    paymentResult.amount,
    paymentResult.asset,
    split,
  );
  let receiptCid: string | null = null;
  try {
    receiptCid = await pinJson(c.env, rec, `receipt-${paymentResult.signature}`);
  } catch (e) {
    console.log(`receipt pin failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Forward the actual call.
  let upstreamResponse: Response;
  if (opts.mode === "a2a" && a2aRpc) {
    const rpcResponse = await forwardA2ACall(record, a2aRpc, {
      "x-clawd-payer": paymentResult.payer,
      "x-clawd-signature": paymentResult.signature,
    });
    upstreamResponse = new Response(JSON.stringify(rpcResponse), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } else {
    const upstream = new URL(
      c.req.url.replace(`${new URL(c.req.url).origin}/agents/${agentId}`, record.endpoint),
    );
    upstreamResponse = await fetch(upstream.toString(), {
      method: c.req.method,
      headers: {
        ...Object.fromEntries(c.req.raw.headers),
        "x-clawd-payer": paymentResult.payer,
        "x-clawd-signature": paymentResult.signature,
      },
      body: ["GET", "HEAD"].includes(c.req.method) ? undefined : await c.req.raw.clone().arrayBuffer(),
    });
  }

  // Decorate the response with the correct receipt header per protocol.
  const out = new Headers(upstreamResponse.headers);
  const receiptHeaders =
    protocol === "mpp"
      ? mppReceiptHeader(paymentResult, c.env.NETWORK)
      : protocol === "ap2"
        ? ap2ReceiptHeader(
            paymentResult,
            { iss: "", sub: paymentResult.payer, aud: "", exp: 0, maxAmount: "", asset: "", resource: "" },
            c.env.NETWORK,
          )
        : paymentResponseHeader(paymentResult, c.env.NETWORK);
  for (const [k, v] of Object.entries(receiptHeaders)) out.set(k, v);
  if (receiptCid) out.set("x-clawd-receipt-cid", receiptCid);

  return new Response(upstreamResponse.body, { status: upstreamResponse.status, headers: out });
}

export default app;
