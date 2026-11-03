import type { BrainEnv, MemoryStore } from "./worker.ts";
import { DISCLAIMER } from "./score.ts";
import { verifyEd25519 } from "./portal.ts";

export const PRO_TRADE_ALLOWANCE = 100;

interface TradeRow {
  remaining: number;
  used: Set<string>;
}

function rows(store: MemoryStore): Map<string, TradeRow> {
  if (!store.proTrades) store.proTrades = new Map();
  return store.proTrades;
}

export function counterMessage(identity: string, remaining: number, allowance = PRO_TRADE_ALLOWANCE): string {
  return `identity=${identity}\nremaining=${remaining}\nallowance=${allowance}`;
}

function identityOk(value: string): boolean {
  return /^[A-Za-z0-9@._:-]{8,160}$/.test(value);
}

async function signCounter(message: string, pem: string): Promise<string | undefined> {
  try {
    const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    const der = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
    const key = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(message));
    let raw = "";
    for (const byte of new Uint8Array(sig)) raw += String.fromCharCode(byte);
    return btoa(raw);
  } catch {
    return undefined;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "x-valhalla-disclaimer": DISCLAIMER,
    },
  });
}

export async function handleProTrades(request: Request, store: MemoryStore, env: BrainEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== "/v1/pro-trades/status" && path !== "/v1/pro-trades/consume") return null;
  if (request.method !== "POST") return json({ error: "POST only", disclaimer: DISCLAIMER }, 405);
  const body = (await request.json().catch(() => ({}))) as { identity?: string; tradeId?: string };
  const identity = String(body.identity ?? "");
  if (!identityOk(identity)) return json({ error: "Identity required", disclaimer: DISCLAIMER }, 400);
  const table = rows(store);
  const row = table.get(identity) ?? { remaining: PRO_TRADE_ALLOWANCE, used: new Set<string>() };
  if (path === "/v1/pro-trades/consume") {
    const tradeId = String(body.tradeId ?? "");
    if (!/^[A-Za-z0-9]{8,128}$/.test(tradeId)) return json({ error: "Trade id required", disclaimer: DISCLAIMER }, 400);
    if (!row.used.has(tradeId) && row.remaining > 0) {
      row.used.add(tradeId);
      row.remaining -= 1;
    }
  }
  table.set(identity, row);
  const message = counterMessage(identity, row.remaining);
  const signature = env.VALHALLA_MONETIZATION_PEM ? await signCounter(message, env.VALHALLA_MONETIZATION_PEM) : undefined;
  return json({
    identity,
    remaining: row.remaining,
    allowance: PRO_TRADE_ALLOWANCE,
    signature,
    disclaimer: DISCLAIMER,
  });
}

export async function handleSiwsVerify(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/v1/siws/verify" || request.method !== "POST") return null;
  const body = (await request.json().catch(() => ({}))) as { pubkey?: string; message?: string; signature?: string };
  const message = String(body.message ?? "");
  const pubkey = String(body.pubkey ?? "");
  if (!message.includes("Sign in to Valhalla") || !message.includes("This is not a transaction.")) {
    return json({ error: "Sign-in message required", disclaimer: DISCLAIMER }, 400);
  }
  if (!message.includes(pubkey)) return json({ error: "Sign-in message required", disclaimer: DISCLAIMER }, 400);
  const exp = /Expiration Time: (.+)/.exec(message);
  if (!exp || Number.isNaN(Date.parse(exp[1])) || Date.parse(exp[1]) < Date.now()) {
    return json({ error: "Sign-in expired", disclaimer: DISCLAIMER }, 401);
  }
  const ok = await verifyEd25519(pubkey, message, String(body.signature ?? "")).catch(() => false);
  if (!ok) return json({ error: "Sign-in was not accepted", disclaimer: DISCLAIMER }, 401);
  return json({ ok: true, address: pubkey, session: crypto.randomUUID(), disclaimer: DISCLAIMER });
}
