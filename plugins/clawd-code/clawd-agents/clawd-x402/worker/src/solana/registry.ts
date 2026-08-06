/**
 * Agent registry client.
 *
 * Agents are stored on-chain as PDAs owned by the clawd-vault program.
 * The PDA seed is [REGISTRY_SEED, agent_id.to_bytes()] — agent_id is any
 * 32-byte identifier, but by convention it's the agent owner's pubkey.
 *
 * Each registry account stores:
 *   owner: Pubkey (32)
 *   manifest_cid: [u8; 64]   (IPFS CIDv1 base32, fixed width)
 *   endpoint: [u8; 128]
 *   split_owner_bps: u16
 *   split_buyback_bps: u16
 *   split_treasury_bps: u16
 *   split_operator_bps: u16
 *   buyback_recipient: Pubkey
 *   treasury_recipient: Pubkey
 *   operator_recipient: Pubkey
 *   protocols_mask: u8       (bits: x402=1, mpp=2, ap2=4, a2a=8)
 *   pricing_count: u8
 *   pricing: [PricingEntry; 16]  // method_hash:[u8;8] -> amount:u64
 *
 * See programs/clawd-vault/src/lib.rs for the canonical account layout.
 */

import { PublicKey } from "@solana/web3.js";
import type { Env, AgentRecord } from "../types";
import { rpcCall } from "./rpc";

export function agentRegistryPda(env: Env, agentId: string): PublicKey {
  const programId = new PublicKey(env.CLAWD_VAULT_PROGRAM);
  const seeds = [
    new TextEncoder().encode(env.REGISTRY_SEED),
    new PublicKey(agentId).toBuffer(),
  ];
  const [pda] = PublicKey.findProgramAddressSync(seeds, programId);
  return pda;
}

/** Fetch a registered agent. Returns null if not found. */
export async function getAgent(env: Env, agentId: string): Promise<AgentRecord | null> {
  const pda = agentRegistryPda(env, agentId);
  const acct = await rpcCall<{ value: { data: [string, string]; owner: string } | null }>(
    env,
    "getAccountInfo",
    [pda.toBase58(), { encoding: "base64", commitment: "confirmed" }],
  );
  if (!acct.value) return null;

  const raw = Uint8Array.from(atob(acct.value.data[0]), (c) => c.charCodeAt(0));
  return decodeRegistryAccount(raw, agentId);
}

function decodeRegistryAccount(raw: Uint8Array, agentId: string): AgentRecord {
  if (raw.length < 8 + 32 + 64 + 128 + 8 + 96 + 2) {
    throw new Error(`registry account too short: ${raw.length} bytes`);
  }
  // Skip Anchor 8-byte discriminator
  let o = 8;

  const owner = new PublicKey(raw.slice(o, o + 32)).toBase58(); o += 32;

  const manifestCid = new TextDecoder().decode(raw.slice(o, o + 64)).replace(/\0+$/, "");
  o += 64;

  const endpoint = new TextDecoder().decode(raw.slice(o, o + 128)).replace(/\0+$/, "");
  o += 128;

  const dv = new DataView(raw.buffer, raw.byteOffset);
  const splitOwnerBps = dv.getUint16(o, true); o += 2;
  const splitBuybackBps = dv.getUint16(o, true); o += 2;
  const splitTreasuryBps = dv.getUint16(o, true); o += 2;
  const splitOperatorBps = dv.getUint16(o, true); o += 2;

  const buybackRecipient = new PublicKey(raw.slice(o, o + 32)).toBase58(); o += 32;
  const treasuryRecipient = new PublicKey(raw.slice(o, o + 32)).toBase58(); o += 32;
  const operatorRecipient = new PublicKey(raw.slice(o, o + 32)).toBase58(); o += 32;

  const mask = raw[o]; o += 1;
  const protocols = {
    x402: (mask & 1) !== 0,
    mpp: (mask & 2) !== 0,
    ap2: (mask & 4) !== 0,
    a2a: (mask & 8) !== 0,
  };

  const pricingCount = raw[o]; o += 1;
  if (pricingCount > 16) {
    throw new Error(`registry pricing_count exceeds max: ${pricingCount}`);
  }
  const pricing: Record<string, string> = {};
  for (let i = 0; i < pricingCount && i < 16; i++) {
    const hash = Array.from(raw.slice(o, o + 8), (b) => b.toString(16).padStart(2, "0")).join(""); o += 8;
    const amount = dv.getBigUint64(o, true); o += 8;
    pricing[hash] = amount.toString();
  }

  return {
    id: agentId,
    owner,
    splitOwnerBps: splitOwnerBps || undefined,
    splitBuybackBps: splitBuybackBps || undefined,
    splitTreasuryBps: splitTreasuryBps || undefined,
    splitOperatorBps: splitOperatorBps || undefined,
    buybackRecipient,
    treasuryRecipient,
    operatorRecipient,
    manifestCid,
    endpoint,
    protocols,
    pricing,
  };
}

/** Deterministic method hash → 8-byte identifier used in the on-chain pricing map. */
export async function methodHash(method: string): Promise<string> {
  const data = new TextEncoder().encode(method);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function priceFor(record: AgentRecord, method: string, hash: string, fallback: bigint): bigint {
  const raw = record.pricing[hash] ?? record.pricing[method] ?? fallback.toString();
  const price = BigInt(raw);
  if (price <= 0n) throw new Error("agent price must be greater than zero");
  return price;
}
