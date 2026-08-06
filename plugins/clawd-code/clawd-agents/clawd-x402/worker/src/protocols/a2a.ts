/**
 * A2A (Agent-to-Agent) protocol adapter.
 *
 * A2A is Google's open protocol for agent interoperability. Agents expose:
 *
 *   GET /.well-known/agent.json   → agent card (skills, endpoints, capabilities)
 *   POST /a2a                     → JSON-RPC 2.0 methods: tasks/send, tasks/get, etc.
 *
 * A2A has no native payment layer, so we wrap it. Calling an A2A method on an agent
 * that's registered in ClawdRouter requires a prior payment via x402, MPP, or AP2.
 *
 * Flow:
 *   1. Caller fetches /a2a/:id/.well-known/agent.json  → gets the card (free).
 *      The card includes a `pricing` extension so callers know what each skill costs.
 *   2. Caller posts to /a2a/:id/tasks/send without payment → 402 with challenge.
 *   3. Caller retries with PAYMENT-SIGNATURE (x402) or Authorization: Payment (MPP)
 *      or X-AP2-Mandate (AP2) + PAYMENT-SIGNATURE.
 *   4. We settle, forward the A2A JSON-RPC call to the agent's endpoint, and return
 *      the task result along with the payment receipt.
 *
 * Reference: https://google-a2a.github.io/A2A/specification/
 */

import type { A2AAgentCard, AgentRecord, Env } from "../types";
import { fetchJson } from "../ipfs/pinata";

/** JSON-RPC 2.0 request envelope used by A2A. */
export interface A2ARequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string; // "tasks/send", "tasks/get", "tasks/cancel", ...
  params: {
    id?: string;
    sessionId?: string;
    message?: {
      role: "user" | "agent";
      parts: Array<
        | { type: "text"; text: string }
        | { type: "file"; file: { name: string; mimeType: string; bytes?: string; uri?: string } }
        | { type: "data"; data: Record<string, unknown> }
      >;
    };
    metadata?: Record<string, unknown>;
  };
}

export interface A2AResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Fetch an agent's card. Cards live at the agent's endpoint under
 * /.well-known/agent.json OR on IPFS via the registry manifestCid. We prefer IPFS
 * because it's content-addressed and signed, but fall back to the live endpoint.
 */
export async function fetchAgentCard(env: Env, record: AgentRecord): Promise<A2AAgentCard> {
  if (record.manifestCid) {
    try {
      return await fetchJson<A2AAgentCard>(env, record.manifestCid);
    } catch {
      // fall through to live fetch
    }
  }

  const url = `${record.endpoint.replace(/\/$/, "")}/.well-known/agent.json`;
  const res = await fetch(url, { cf: { cacheTtl: 60, cacheEverything: true } });
  if (!res.ok) throw new Error(`A2A card fetch failed: ${res.status}`);
  return (await res.json()) as A2AAgentCard;
}

/**
 * Forward a settled A2A call to the upstream agent. This happens *after* payment
 * has verified, so we trust the caller-supplied JSON-RPC envelope and just proxy.
 */
export async function forwardA2ACall(
  record: AgentRecord,
  rpc: A2ARequest,
  extraHeaders: Record<string, string> = {},
): Promise<A2AResponse> {
  const res = await fetch(`${record.endpoint.replace(/\/$/, "")}/a2a`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-by": "clawdrouter",
      ...extraHeaders,
    },
    body: JSON.stringify(rpc),
  });

  if (!res.ok) {
    return {
      jsonrpc: "2.0",
      id: rpc.id,
      error: { code: -32603, message: `upstream agent ${res.status}`, data: await res.text() },
    };
  }
  return (await res.json()) as A2AResponse;
}

/**
 * Price lookup for an A2A method call. A2A methods are namespaced by skill,
 * so we use the skill id (from the card) as the pricing key. `tasks/send` with
 * metadata.skillId = "generate_image" → looks up record.pricing["generate_image"].
 */
export function priceForA2ACall(record: AgentRecord, rpc: A2ARequest, fallback: bigint): bigint {
  const skillId = rpc.params.metadata?.["skillId"];
  if (typeof skillId === "string" && record.pricing[skillId]) {
    return parsePositivePrice(record.pricing[skillId]);
  }
  // Per-method fallback: charge the default method price
  if (record.pricing[rpc.method]) {
    return parsePositivePrice(record.pricing[rpc.method]);
  }
  return fallback;
}

function parsePositivePrice(raw: string): bigint {
  const price = BigInt(raw);
  if (price <= 0n) throw new Error("agent price must be greater than zero");
  return price;
}
