import { pollCryptoOrders } from "./crypto-pay.ts";
import { handleProTrades, handleSiwsVerify } from "./pro-trades.ts";
import { handlePortal } from "./portal.ts";
import {
  DISCLAIMER,
  offerHint,
  PLAN_LIMITS,
  type PlanName,
  scoreFromFacts,
  withinLimit,
} from "./score.ts";
import { factsForMint, publicWalletSummary, trendingMints } from "./upstream.ts";

export interface MemoryStore {
  keys: Map<string, PlanName>;
  usage: Map<string, number>;
  portal?: {
    nonces: Map<string, { pubkey: string; message: string; exp: number }>;
    users: Map<string, { id: string; email: string; plan: "free" | "pro"; wallets: string[]; licenseTail: string; telegram: string; createdAt: number }>;
    sessions: Map<string, { id: string; userId: string; csrf: string; exp: number; createdAt: number }>;
    walletIndex: Map<string, string>;
    emailIndex: Map<string, string>;
    apiKeys: Map<string, { userId: string; tail: string; hash: string }>;
    watch: Map<string, string[]>;
    hits: Map<string, number[]>;
  };
  proTrades?: Map<string, { remaining: number; used: Set<string> }>;
  crypto?: { orders: Map<string, unknown>; receipts: unknown[]; seen: Set<string> };
}

export interface D1Statement {
  bind(...args: unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
  all<T>(): Promise<{ results: T[] }>;
}

export interface BrainEnv {
  DB?: { prepare(sql: string): D1Statement };
  KV?: { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void> };
  HELIUS_API_KEY?: string;
  BIRDEYE_API_KEY?: string;
  /** Comma or newline list of "sha256:plan". Raw keys are ignored. */
  BRAIN_KEYS?: string;
  LEMONSQUEEZY_SIGNING_SECRET?: string;
  LEMONSQUEEZY_API_KEY?: string;
  LEMONSQUEEZY_PORTAL_URL?: string;
  SESSION_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  /** Comma-separated Google emails. Never put a real address in the repo. */
  ADMIN_EMAILS?: string;
  /** PKCS8 PEM. Not stored in the repo. Counters are unsigned until this is set. */
  VALHALLA_MONETIZATION_PEM?: string;
  /** Public URL of the signed monetization.json. Defaults to the site copy. */
  MONETIZATION_URL?: string;
  fetchImpl?: typeof fetch;
}

const PLANS = new Set<PlanName>(["free", "dev", "pro"]);

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256Hex(secret: string, raw: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  return [...new Uint8Array(mac)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-valhalla-disclaimer": DISCLAIMER,
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type, x-signature",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    },
  });
}

function dayStamp(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function parsePlans(raw: string | undefined): Map<string, PlanName> {
  const keys = new Map<string, PlanName>();
  for (const part of (raw ?? "").split(/[\n,]/)) {
    const [hash, plan] = part.trim().split(":");
    if (hash && plan && /^[a-f0-9]{64}$/.test(hash) && PLANS.has(plan as PlanName)) {
      keys.set(hash, plan as PlanName);
    }
  }
  return keys;
}

function mintOk(mint: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint);
}

async function lookupPlan(hash: string, store: MemoryStore, env: BrainEnv): Promise<PlanName | null> {
  const memory = store.keys.get(hash);
  if (memory) return memory;
  const fromSecret = parsePlans(env.BRAIN_KEYS).get(hash);
  if (fromSecret) return fromSecret;
  if (!env.DB) return null;
  const row = await env.DB.prepare("SELECT plan FROM api_keys WHERE key_hash = ?")
    .bind(hash)
    .first<{ plan: string }>();
  if (row && PLANS.has(row.plan as PlanName)) return row.plan as PlanName;
  return null;
}

async function callsToday(hash: string, store: MemoryStore, env: BrainEnv): Promise<number> {
  const usageKey = `${hash}:${dayStamp()}`;
  if (env.KV) return Number((await env.KV.get(`usage:${usageKey}`)) ?? "0");
  if (env.DB && !store.keys.has(hash)) {
    const row = await env.DB.prepare("SELECT calls FROM usage_daily WHERE key_hash = ? AND day = ?")
      .bind(hash, dayStamp())
      .first<{ calls: number }>();
    return row?.calls ?? 0;
  }
  return store.usage.get(usageKey) ?? 0;
}

async function bump(hash: string, store: MemoryStore, env: BrainEnv, used: number): Promise<number> {
  const next = used + 1;
  const usageKey = `${hash}:${dayStamp()}`;
  store.usage.set(usageKey, next);
  if (env.KV) await env.KV.put(`usage:${usageKey}`, String(next));
  if (env.DB) {
    await env.DB.prepare(
      "INSERT INTO usage_daily (key_hash, day, calls) VALUES (?, ?, ?) ON CONFLICT(key_hash, day) DO UPDATE SET calls = excluded.calls"
    )
      .bind(hash, dayStamp(), next)
      .run();
  }
  return next;
}

async function applyLemon(raw: string, request: Request, store: MemoryStore, env: BrainEnv): Promise<Response> {
  const secret = (env.LEMONSQUEEZY_SIGNING_SECRET ?? "").trim();
  if (!secret) return json({ error: "Not found", disclaimer: DISCLAIMER }, 404);
  const signature = request.headers.get("x-signature") ?? "";
  const expected = await hmacSha256Hex(secret, raw);
  if (signature.length !== expected.length || signature !== expected) {
    return json({ error: "Bad signature", disclaimer: DISCLAIMER }, 401);
  }
  const body = JSON.parse(raw) as {
    meta?: { event_name?: string; custom_data?: { api_key_hash?: string } };
    data?: { attributes?: { status?: string } };
  };
  const event = body.meta?.event_name ?? "";
  const hash = body.meta?.custom_data?.api_key_hash ?? "";
  if (!/^[a-f0-9]{64}$/.test(hash)) return json({ error: "api_key_hash required", disclaimer: DISCLAIMER }, 400);
  const active = body.data?.attributes?.status === "active";
  const plan: PlanName =
    active && (event === "subscription_created" || event === "subscription_updated") ? "pro" : "free";
  if (store.keys.has(hash) || !env.DB) store.keys.set(hash, plan);
  if (env.DB) {
    await env.DB.prepare(
      "INSERT INTO api_keys (key_hash, plan, created_at) VALUES (?, ?, ?) ON CONFLICT(key_hash) DO UPDATE SET plan = excluded.plan"
    )
      .bind(hash, plan, new Date().toISOString())
      .run();
  }
  return json({ ok: true, plan, disclaimer: DISCLAIMER });
}

export async function handleRequest(
  request: Request,
  store: MemoryStore,
  env: BrainEnv = {}
): Promise<Response> {
  if (request.method === "OPTIONS") return json({ ok: true });
  const url = new URL(request.url);
  const signIn = await handleSiwsVerify(request);
  if (signIn) return signIn;
  const trades = await handleProTrades(request, store, env);
  if (trades) return trades;
  const portal = await handlePortal(request, store, env);
  if (portal) return portal;
  const fetcher = env.fetchImpl ?? fetch;
  if (request.method === "GET" && url.pathname === "/v1/health") {
    return json({ ok: true, service: "valhalla-brain", disclaimer: DISCLAIMER });
  }
  if (request.method === "POST" && url.pathname === "/v1/billing/lemon") {
    return applyLemon(await request.text(), request, store, env);
  }

  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "API key required", disclaimer: DISCLAIMER }, 401);
  const keyHash = await sha256Hex(token);
  const plan = await lookupPlan(keyHash, store, env);
  if (!plan) return json({ error: "Unknown API key", disclaimer: DISCLAIMER }, 401);
  const used = await callsToday(keyHash, store, env);
  if (!withinLimit(plan, used)) {
    return json({ error: "Daily limit reached", plan, limit: PLAN_LIMITS[plan], disclaimer: DISCLAIMER }, 429);
  }

  if (request.method === "GET" && url.pathname === "/v1/usage") {
    return json({
      plan,
      callsToday: used,
      limit: PLAN_LIMITS[plan],
      lemon: "Daily rows can map to a Lemon Squeezy plan. This response does not charge a card.",
      disclaimer: DISCLAIMER,
    });
  }

  await bump(keyHash, store, env, used);

  if (request.method === "GET" && url.pathname.startsWith("/v1/score/")) {
    const mint = decodeURIComponent(url.pathname.slice("/v1/score/".length));
    if (!mintOk(mint)) return json({ error: "Mint must be a public address", disclaimer: DISCLAIMER }, 400);
    const upstream = await factsForMint(mint, env, fetcher);
    const scored = scoreFromFacts(upstream.facts);
    return json({ mint, ...scored, offer: offerHint(scored.score), upstream: upstream.upstream });
  }
  if (request.method === "POST" && url.pathname === "/v1/score/batch") {
    const body = (await request.json().catch(() => ({}))) as { mints?: string[] };
    const mints = Array.isArray(body.mints) ? body.mints.slice(0, 20) : [];
    const results = [];
    for (const mint of mints) {
      if (!mintOk(mint)) continue;
      const upstream = await factsForMint(mint, env, fetcher);
      const scored = scoreFromFacts(upstream.facts);
      results.push({ mint, ...scored, offer: offerHint(scored.score), upstream: upstream.upstream });
    }
    return json({ results, disclaimer: DISCLAIMER });
  }
  if (request.method === "GET" && url.pathname.startsWith("/v1/wallet/") && url.pathname.endsWith("/summary")) {
    const pubkey = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    if (!mintOk(pubkey)) return json({ error: "Public key required", disclaimer: DISCLAIMER }, 400);
    const summary = await publicWalletSummary(pubkey, env, fetcher);
    return json({
      tail: pubkey.slice(-4),
      sol: summary.sol,
      publicDataOnly: true,
      note: summary.note,
      disclaimer: DISCLAIMER,
    });
  }
  if (request.method === "GET" && url.pathname === "/v1/trending") {
    const trending = await trendingMints(env, fetcher);
    return json({ ...trending, disclaimer: DISCLAIMER });
  }
  return json({ error: "Not found", disclaimer: DISCLAIMER }, 404);
}

const durable: MemoryStore = { keys: new Map(), usage: new Map() };

export default {
  async fetch(request: Request, env: BrainEnv = {}): Promise<Response> {
    return handleRequest(request, durable, env);
  },
  async scheduled(_event: unknown, env: BrainEnv = {}): Promise<void> {
    await pollCryptoOrders(durable, env);
  },
};
