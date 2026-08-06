/**
 * @solanaclawd/x402-client
 *
 * Drop-in fetch wrapper that handles x402 (and MPP, AP2) payments automatically
 * on Solana. The SDK detects 402 responses, signs an SPL transfer with your
 * keypair, and retries the original request with the payment attached.
 *
 * Example:
 *   import { clawdFetch } from "@solanaclawd/x402-client";
 *   import { Keypair, Connection } from "@solana/web3.js";
 *
 *   const signer = Keypair.fromSecretKey(secret);
 *   const conn = new Connection("https://mainnet.helius-rpc.com/?api-key=...");
 *
 *   const res = await clawdFetch("https://x402.wtf/agents/<id>/summarize", {
 *     method: "POST",
 *     body: JSON.stringify({ url: "..." }),
 *     signer, connection: conn,
 *     onPaymentRequired: async (req) => confirm(`Pay ${req.maxAmountRequired}?`),
 *   });
 */

import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import {
  createPTokenTransferChecked,
  createPTokenATAIdempotent,
  createPTokenComputeBudget,
  getPTokenATA,
} from "./p-token.js";
import bs58 from "bs58";

export interface SolanaPaymentRequirement {
  scheme: "exact";
  network: "solana" | "solana-devnet";
  resource: string;
  description: string;
  payTo: string;
  asset: string;
  maxAmountRequired: string;
  maxTimeoutSeconds: number;
  extra: {
    decimals: number;
    recentBlockhash?: string;
    memo?: string;
  };
}

export interface ClawdFetchOptions extends RequestInit {
  signer: Keypair;
  connection: Connection;
  /** Preferred protocol. Defaults to x402. */
  protocol?: "x402" | "mpp" | "ap2";
  /** Called before paying. Return `false` to abort. If omitted, pays automatically. */
  onPaymentRequired?: (req: SolanaPaymentRequirement) => Promise<boolean> | boolean;
  /** Advertise payer identity so the gateway can apply holder discounts on the first leg. */
  advertisePayer?: boolean;
  /** For AP2 flow: caller-provided JWT-VC intent mandate. */
  ap2Mandate?: string;
}

export interface ClawdFetchResult extends Response {
  receiptCid?: string;
  signature?: string;
}

export async function clawdFetch(
  url: string,
  opts: ClawdFetchOptions,
): Promise<ClawdFetchResult> {
  const headers = new Headers(opts.headers ?? {});
  if (opts.advertisePayer !== false) {
    headers.set("x-payer", opts.signer.publicKey.toBase58());
  }
  if (opts.protocol === "mpp") headers.set("accept", "application/mpp+json");
  if (opts.protocol === "ap2" && opts.ap2Mandate) {
    headers.set("x-ap2-mandate", opts.ap2Mandate);
  }

  // First attempt — no payment.
  const first = await fetch(url, { ...opts, headers });
  if (first.status !== 402) return decorate(first);

  const challenge = await extractChallenge(first, opts.protocol ?? "x402");
  if (!challenge) throw new Error(`402 without parseable challenge`);

  if (opts.onPaymentRequired) {
    const ok = await opts.onPaymentRequired(challenge);
    if (!ok) throw new Error("payment declined by caller");
  }

  const signedTx = await buildAndSignTransfer(challenge, opts.signer, opts.connection);
  const signatureB64 = Buffer.from(signedTx.serialize()).toString("base64");

  const paidHeaders = new Headers(headers);
  if (opts.protocol === "mpp") {
    paidHeaders.set("authorization", `Payment method=solana-exact, tx="${signatureB64}"`);
  } else {
    paidHeaders.set("payment-signature", signatureB64);
  }

  const paid = await fetch(url, { ...opts, headers: paidHeaders });
  return decorate(paid);
}

async function extractChallenge(
  res: Response,
  protocol: "x402" | "mpp" | "ap2",
): Promise<SolanaPaymentRequirement | null> {
  if (protocol === "mpp") {
    // MPP puts the challenge both in WWW-Authenticate and the body.
    const body = (await res.clone().json()) as {
      methods: Array<{
        network: string;
        recipient: string;
        asset: string;
        amount: string;
        decimals: number;
        nonce: string;
      }>;
    };
    const m = body.methods?.[0];
    if (!m) return null;
    return {
      scheme: "exact",
      network: (m.network === "solana-devnet" ? "solana-devnet" : "solana") as "solana" | "solana-devnet",
      resource: new URL(res.url).pathname,
      description: "MPP charge",
      payTo: m.recipient,
      asset: m.asset,
      maxAmountRequired: m.amount,
      maxTimeoutSeconds: 60,
      extra: { decimals: m.decimals, recentBlockhash: m.nonce },
    };
  }

  if (protocol === "ap2") {
    const body = (await res.clone().json()) as {
      maxAmount: string;
      asset: string;
      resource: string;
      settlement: { network: string; recipient: string; decimals: number };
    };
    return {
      scheme: "exact",
      network: (body.settlement.network === "solana-devnet" ? "solana-devnet" : "solana") as
        | "solana"
        | "solana-devnet",
      resource: body.resource,
      description: "AP2 settlement",
      payTo: body.settlement.recipient,
      asset: body.asset,
      maxAmountRequired: body.maxAmount,
      maxTimeoutSeconds: 60,
      extra: { decimals: body.settlement.decimals },
    };
  }

  // x402: prefer header, fall back to body.accepts[0]
  const header = res.headers.get("payment-required");
  if (header) {
    return JSON.parse(atob(header)) as SolanaPaymentRequirement;
  }
  const body = (await res.clone().json()) as { accepts?: SolanaPaymentRequirement[] };
  return body.accepts?.[0] ?? null;
}

async function buildAndSignTransfer(
  req: SolanaPaymentRequirement,
  signer: Keypair,
  connection: Connection,
): Promise<VersionedTransaction> {
  const mint = new PublicKey(req.asset);
  const payToOwner = new PublicKey(req.payTo);
  // p-token: same ATA address, just locks in the optimised program ID
  const destAta = getPTokenATA(mint, payToOwner);
  const sourceAta = getPTokenATA(mint, signer.publicKey);

  const instructions = [
    // p-token TransferChecked: 105 CU vs SPL's 6,200 (~98% cheaper)
    ...createPTokenComputeBudget(),
    // idempotent — no-op if the destination ATA already exists
    createPTokenATAIdempotent(signer.publicKey, destAta, payToOwner, mint),
    createPTokenTransferChecked(
      sourceAta, mint, destAta,
      signer.publicKey,
      BigInt(req.maxAmountRequired),
      req.extra.decimals,
    ),
  ];

  // Use the blockhash named in the challenge when present — this binds the tx
  // to the server's challenge window. Otherwise fetch a fresh one.
  const recentBlockhash =
    req.extra.recentBlockhash ?? (await connection.getLatestBlockhash("finalized")).blockhash;

  const message = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([signer]);
  return tx;
}

function decorate(res: Response): ClawdFetchResult {
  const decorated = res as ClawdFetchResult;
  decorated.receiptCid = res.headers.get("x-clawd-receipt-cid") ?? undefined;

  const payResp = res.headers.get("payment-response") ?? res.headers.get("payment-receipt");
  if (payResp) {
    try {
      const parsed = JSON.parse(atob(payResp)) as { signature?: string };
      decorated.signature = parsed.signature;
    } catch {
      /* ignore malformed */
    }
  }
  return decorated;
}

/* ——— Discovery helpers ——— */

export interface AgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  skills: Array<{ id: string; name: string; description: string }>;
  pricing?: Record<string, { amount: string; asset: string; protocols: string[] }>;
}

export async function getAgentCard(gatewayOrigin: string, agentId: string): Promise<AgentCard> {
  const res = await fetch(`${gatewayOrigin}/x402/a2a/${agentId}/.well-known/agent.json`);
  if (!res.ok) throw new Error(`agent card fetch failed: ${res.status}`);
  return (await res.json()) as AgentCard;
}

export async function getRegistryEntry(gatewayOrigin: string, agentId: string): Promise<unknown> {
  const res = await fetch(`${gatewayOrigin}/x402/registry/${agentId}`);
  if (!res.ok) throw new Error(`registry fetch failed: ${res.status}`);
  return res.json();
}
