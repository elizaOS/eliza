/**
 * Pinata IPFS client.
 *
 * Two things get pinned:
 *   1. Agent manifests — the A2A agent card + extended pricing info.
 *      Pinned once at registration; CID stored on-chain in the registry.
 *   2. Settlement receipts — one per successful payment. CID is returned
 *      in the PAYMENT-RESPONSE header so both sides have a tamper-evident
 *      record of the transaction.
 *
 * Served via the custom gateway at ipfs.x402.wtf/{cid}.
 */

import type { Env } from "../types";

const PINATA_API = "https://api.pinata.cloud";

interface PinResponse {
  IpfsHash: string;
  PinSize: number;
  Timestamp: string;
}

export async function pinJson(env: Env, data: unknown, name: string): Promise<string> {
  const res = await fetch(`${PINATA_API}/pinning/pinJSONToIPFS`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.PINATA_JWT}`,
    },
    body: JSON.stringify({
      pinataMetadata: { name },
      pinataContent: data,
    }),
  });

  if (!res.ok) {
    throw new Error(`Pinata pin failed: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as PinResponse;
  return json.IpfsHash;
}

export function gatewayUrl(env: Env, cid: string): string {
  return `${env.PINATA_GATEWAY}/ipfs/${cid}`;
}

export async function fetchJson<T = unknown>(env: Env, cid: string): Promise<T> {
  const url = gatewayUrl(env, cid);
  const res = await fetch(url, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!res.ok) throw new Error(`IPFS fetch ${cid} failed: ${res.status}`);
  return (await res.json()) as T;
}
