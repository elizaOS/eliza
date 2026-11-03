import { openOrder, orderView, persistCrypto, readPayConfig, receiptsCsv } from "./crypto-pay.ts";
import { decodeBase58 } from "./base58.ts";
import { DISCLAIMER } from "./score.ts";
import type { BrainEnv, MemoryStore } from "./worker.ts";
import { PORTAL_HTML, PORTAL_JS } from "./portal-page.ts";

const COOKIE = "valhalla_session";
const CSRF = "valhalla_csrf";
const NONCE_MS = 5 * 60 * 1000;
const SESSION_MS = 14 * 24 * 60 * 60 * 1000;
const PRODUCT_ID = 1498767;

export interface PortalUser {
  id: string;
  email: string;
  plan: "free" | "pro";
  wallets: string[];
  licenseTail: string;
  telegram: string;
  createdAt: number;
}

interface SessionRow {
  id: string;
  userId: string;
  csrf: string;
  exp: number;
  createdAt: number;
}

interface NonceRow {
  pubkey: string;
  message: string;
  exp: number;
}

export interface PortalData {
  nonces: Map<string, NonceRow>;
  users: Map<string, PortalUser>;
  sessions: Map<string, SessionRow>;
  walletIndex: Map<string, string>;
  emailIndex: Map<string, string>;
  apiKeys: Map<string, { userId: string; tail: string; hash: string }>;
  watch: Map<string, string[]>;
  hits: Map<string, number[]>;
  offerClicks: Map<string, number>;
  clickHits: Map<string, number[]>;
}

function portalOf(store: MemoryStore): PortalData {
  if (!store.portal) {
    store.portal = {
      nonces: new Map(),
      users: new Map(),
      sessions: new Map(),
      walletIndex: new Map(),
      emailIndex: new Map(),
      apiKeys: new Map(),
      watch: new Map(),
      hits: new Map(),
      offerClicks: new Map(),
      clickHits: new Map(),
    };
  }
  return store.portal;
}

function bytesToB64Url(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function b64UrlToBytes(value: string): Uint8Array {
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const raw = atob(value.replaceAll("-", "+").replaceAll("_", "/") + pad);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

async function signJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const body = bytesToB64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `${body}.${bytesToB64Url(mac)}`;
}

async function readJwt(token: string, secret: string): Promise<Record<string, unknown> | null> {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const ok = await crypto.subtle.verify("HMAC", key, b64UrlToBytes(mac), new TextEncoder().encode(body));
  if (!ok) return null;
  return JSON.parse(new TextDecoder().decode(b64UrlToBytes(body))) as Record<string, unknown>;
}

export function siwsMessage(host: string, pubkey: string, nonce: string, issued: string, exp: string): string {
  return `${host} wants you to sign in with your Solana account:\n${pubkey}\n\nSign in to Valhalla. Read-only. This is not a transaction.\n\nNonce: ${nonce}\nIssued At: ${issued}\nExpiration Time: ${exp}`;
}

export async function verifyEd25519(pubkey: string, message: string, signatureB64: string): Promise<boolean> {
  const rawKey = decodeBase58(pubkey);
  if (!rawKey || rawKey.length !== 32) return false;
  const signature = Uint8Array.from(atob(signatureB64), (char) => char.charCodeAt(0));
  if (signature.length !== 64) return false;
  const key = await crypto.subtle.importKey("raw", rawKey, { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify("Ed25519", key, signature, new TextEncoder().encode(message));
}

function cookie(name: string, value: string, maxAge: number, httpOnly: boolean): string {
  const flags = [`Path=/`, `Max-Age=${maxAge}`, `SameSite=Lax`, `Secure`];
  if (httpOnly) flags.push("HttpOnly");
  return `${name}=${value}; ${flags.join("; ")}`;
}

function json(body: unknown, status = 200, extra: string[] = []): Response {
  const headers = new Headers({
    "content-type": "application/json",
    "x-valhalla-disclaimer": DISCLAIMER,
    "cache-control": "no-store",
  });
  for (const item of extra) headers.append("set-cookie", item);
  return new Response(JSON.stringify(body), { status, headers });
}

function limited(data: PortalData, ip: string, now: number): boolean {
  const windowMs = 10 * 60 * 1000;
  const recent = (data.hits.get(ip) ?? []).filter((at) => now - at < windowMs);
  recent.push(now);
  data.hits.set(ip, recent);
  return recent.length > 30;
}

function readCookie(header: string, name: string): string {
  const hit = header.split(/;\s*/).find((part) => part.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : "";
}

function adminEmails(env: BrainEnv): Set<string> {
  return new Set(
    (env.ADMIN_EMAILS ?? "")
      .split(/[\s,]+/)
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.includes("@"))
  );
}

async function sessionUser(request: Request, data: PortalData, env: BrainEnv, now: number) {
  const secret = env.SESSION_SECRET ?? "";
  if (!secret) return null;
  const token = readCookie(request.headers.get("cookie") ?? "", COOKIE);
  if (!token) return null;
  const payload = await readJwt(token, secret);
  const sid = String(payload?.sid ?? "");
  const row = data.sessions.get(sid);
  if (!row || row.exp < now) return null;
  const user = data.users.get(row.userId);
  if (!user) return null;
  return { user, row };
}

function view(user: PortalUser, admin: boolean) {
  return {
    id: user.id,
    email: user.email,
    plan: user.plan,
    wallets: user.wallets.map((pubkey) => ({ tail: pubkey.slice(-4) })),
    licenseTail: user.licenseTail,
    telegram: user.telegram,
    admin,
    disclaimer: DISCLAIMER,
  };
}

function newUser(plan: "free" | "pro" = "free"): PortalUser {
  return { id: crypto.randomUUID(), email: "", plan, wallets: [], licenseTail: "", telegram: "", createdAt: Date.now() };
}

async function issueSession(user: PortalUser, data: PortalData, env: BrainEnv, now: number): Promise<string[]> {
  const secret = env.SESSION_SECRET ?? "";
  const sid = crypto.randomUUID();
  const csrf = crypto.randomUUID();
  data.sessions.set(sid, { id: sid, userId: user.id, csrf, exp: now + SESSION_MS, createdAt: now });
  const jwt = await signJwt({ sid, exp: now + SESSION_MS }, secret);
  return [cookie(COOKIE, jwt, SESSION_MS / 1000, true), cookie(CSRF, encodeURIComponent(csrf), SESSION_MS / 1000, false)];
}

function csrfOk(request: Request, row: SessionRow): boolean {
  return request.headers.get("x-csrf") === row.csrf;
}

function clickLimited(data: PortalData, ip: string, now: number): boolean {
  const recent = (data.clickHits.get(ip) ?? []).filter((at) => now - at < 60_000);
  if (recent.length >= 30) {
    data.clickHits.set(ip, recent);
    return true;
  }
  recent.push(now);
  data.clickHits.set(ip, recent);
  return false;
}

async function countOfferClick(request: Request, data: PortalData, env: BrainEnv): Promise<Response> {
  if (!data.offerClicks) data.offerClicks = new Map();
  if (!data.clickHits) data.clickHits = new Map();
  if (request.method !== "POST") return json({ error: "POST only", disclaimer: DISCLAIMER }, 405);
  const ip = request.headers.get("cf-connecting-ip") || "local";
  if (clickLimited(data, ip, Date.now())) return json({ error: "Too many clicks", disclaimer: DISCLAIMER }, 429);
  const raw = await request.text();
  if (raw.length > 400) return json({ error: "Too large", disclaimer: DISCLAIMER }, 400);
  let body: { id?: string; placement?: string };
  try {
    body = JSON.parse(raw) as { id?: string; placement?: string };
  } catch {
    return json({ error: "Bad JSON", disclaimer: DISCLAIMER }, 400);
  }
  const id = String(body.id ?? "");
  const placement = String(body.placement ?? "");
  if (!/^[a-z0-9-]{1,40}$/.test(id) || !/^[a-z0-9-]{1,40}$/.test(placement)) {
    return json({ error: "Offer id required", disclaimer: DISCLAIMER }, 400);
  }
  const key = `${id}:${placement}`;
  data.offerClicks.set(key, (data.offerClicks.get(key) ?? 0) + 1);
  if (env.DB) {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS offer_clicks (offer_id TEXT NOT NULL, placement TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (offer_id, placement))"
    ).run();
    await env.DB.prepare(
      "INSERT INTO offer_clicks (offer_id, placement, count) VALUES (?, ?, 1) ON CONFLICT(offer_id, placement) DO UPDATE SET count = count + 1"
    )
      .bind(id, placement)
      .run();
  }
  const response = json({ ok: true });
  response.headers.set("access-control-allow-origin", "*");
  return response;
}

async function offerTotals(data: PortalData, env: BrainEnv): Promise<Array<{ id: string; placement: string; count: number }>> {
  if (env.DB) {
    try {
      const rows = await env.DB.prepare("SELECT offer_id, placement, count FROM offer_clicks").all<{
        offer_id: string;
        placement: string;
        count: number;
      }>();
      if (rows.results.length) {
        return rows.results.map((row) => ({ id: row.offer_id, placement: row.placement, count: row.count }));
      }
    } catch {
      // The table appears on the first click.
    }
  }
  return [...(data.offerClicks?.entries() ?? [])].map(([key, count]) => {
    const [id, placement] = key.split(":");
    return { id: id ?? "", placement: placement ?? "", count };
  });
}

export async function handlePortal(request: Request, store: MemoryStore, env: BrainEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const portalPath = path === "/app" || path.startsWith("/app/") || path.startsWith("/v1/auth") || path.startsWith("/v1/me") || path.startsWith("/v1/admin") || path.startsWith("/v1/crypto") || path === "/v1/offers/click";
  if (!portalPath) return null;
  const data = portalOf(store);
  const now = Date.now();
  const csp = "default-src 'self'; script-src 'self' https://accounts.google.com; frame-src https://accounts.google.com; connect-src 'self' https://valhalla-app.xyz; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://valhalla-app.xyz; base-uri 'none'; object-src 'none'";
  if (path === "/v1/offers/click") return countOfferClick(request, data, env);
  if (request.method === "GET" && (path === "/app" || path === "/app/")) {
    return new Response(PORTAL_HTML, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": csp, "cache-control": "no-store" } });
  }
  if (request.method === "GET" && path === "/app/portal.js") {
    return new Response(PORTAL_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "content-security-policy": csp, "cache-control": "no-store" } });
  }
  if (request.method === "GET" && path === "/v1/auth/config") {
    return json({ googleClientId: env.GOOGLE_CLIENT_ID ?? "", billingUrl: env.LEMONSQUEEZY_PORTAL_URL || "https://app.lemonsqueezy.com/my-orders", disclaimer: DISCLAIMER });
  }
  const ip = request.headers.get("cf-connecting-ip") || "local";
  if (path.startsWith("/v1/auth") && limited(data, ip, now)) return json({ error: "Too many sign-in attempts", disclaimer: DISCLAIMER }, 429);
  if (!env.SESSION_SECRET && path !== "/v1/auth/config") return json({ error: "Sign-in is not configured", disclaimer: DISCLAIMER }, 503);

  if (request.method === "POST" && path === "/v1/auth/nonce") {
    const body = (await request.json().catch(() => ({}))) as { pubkey?: string };
    const pubkey = String(body.pubkey ?? "");
    if (!decodeBase58(pubkey) || decodeBase58(pubkey)?.length !== 32) return json({ error: "Public key required", disclaimer: DISCLAIMER }, 400);
    const nonce = crypto.randomUUID();
    const issued = new Date(now).toISOString();
    const exp = new Date(now + NONCE_MS).toISOString();
    const message = siwsMessage(url.host, pubkey, nonce, issued, exp);
    data.nonces.set(nonce, { pubkey, message, exp: now + NONCE_MS });
    return json({ nonce, message, disclaimer: DISCLAIMER });
  }

  if (request.method === "POST" && path === "/v1/auth/siws") {
    const body = (await request.json().catch(() => ({}))) as { pubkey?: string; signature?: string; nonce?: string };
    const row = data.nonces.get(String(body.nonce ?? ""));
    if (!row || row.exp < now || row.pubkey !== body.pubkey) return json({ error: "Login expired", disclaimer: DISCLAIMER }, 401);
    const valid = await verifyEd25519(row.pubkey, row.message, String(body.signature ?? "")).catch(() => false);
    if (!valid) return json({ error: "Login was not accepted", disclaimer: DISCLAIMER }, 401);
    data.nonces.delete(String(body.nonce));
    let userId = data.walletIndex.get(row.pubkey);
    let user = userId ? data.users.get(userId) : undefined;
    if (!user) {
      user = newUser();
      user.wallets = [row.pubkey];
      data.users.set(user.id, user);
      data.walletIndex.set(row.pubkey, user.id);
    }
    return json({ ok: true, ...view(user, false) }, 200, await issueSession(user, data, env, now));
  }

  if (request.method === "POST" && path === "/v1/auth/google") {
    const body = (await request.json().catch(() => ({}))) as { credential?: string };
    if (!env.GOOGLE_CLIENT_ID) return json({ error: "Google sign-in is not configured", disclaimer: DISCLAIMER }, 503);
    const checked = await googleEmail(String(body.credential ?? ""), env);
    if (!checked) return json({ error: "Google sign-in was not accepted", disclaimer: DISCLAIMER }, 401);
    let user = data.users.get(data.emailIndex.get(checked) ?? "");
    if (!user) {
      user = newUser();
      user.email = checked;
      data.users.set(user.id, user);
      data.emailIndex.set(checked, user.id);
    }
    const admin = adminEmails(env).has(checked);
    return json({ ok: true, ...view(user, admin) }, 200, await issueSession(user, data, env, now));
  }

  const current = await sessionUser(request, data, env, now);
  if (request.method === "POST" && path === "/v1/auth/logout") {
    if (current) data.sessions.delete(current.row.id);
    return json({ ok: true }, 200, [cookie(COOKIE, "", 0, true), cookie(CSRF, "", 0, false)]);
  }
  if (!current) return json({ error: "Sign in required", disclaimer: DISCLAIMER }, 401);
  if (request.method !== "GET" && !csrfOk(request, current.row)) return json({ error: "Refresh the page and try again", disclaimer: DISCLAIMER }, 403);
  const user = current.user;
  const admin = adminEmails(env).has(user.email.toLowerCase());

  if (request.method === "POST" && path === "/v1/crypto/order") {
    if (!user.email.includes("@")) return json({ error: "Sign in with Google before paying with crypto", disclaimer: DISCLAIMER }, 400);
    const config = await readPayConfig(env);
    if (!config) return json({ error: "Crypto checkout is off until the signed config verifies", disclaimer: DISCLAIMER }, 503);
    const body = (await request.json().catch(() => ({}))) as { plan?: string; asset?: string };
    const plan = body.plan === "yearly" || body.plan === "lifetime" ? body.plan : "monthly";
    const asset = body.asset === "sol" ? "sol" : "usdc";
    let solPriceUsd = 0;
    if (asset === "sol") {
      const fetcher = env.fetchImpl ?? fetch;
      try {
        const quote = await fetcher("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
        const priced = (await quote.json()) as { solana?: { usd?: number } };
        solPriceUsd = Number(priced.solana?.usd || 0);
      } catch {
        solPriceUsd = 0;
      }
      if (!solPriceUsd) return json({ error: "SOL price is not available. Pay with USDC.", disclaimer: DISCLAIMER }, 503);
    }
    const order = await openOrder(store, { userId: user.id, email: user.email, plan, asset, config, solPriceUsd, now });
    if (!order) return json({ error: "Crypto checkout is off", disclaimer: DISCLAIMER }, 503);
    await persistCrypto(env, store);
    return json({ ok: true, ...orderView(order) });
  }
  if (request.method === "GET" && path === "/v1/admin/crypto-receipts.csv") {
    if (!admin) return json({ error: "Not an admin", disclaimer: DISCLAIMER }, 403);
    return new Response(receiptsCsv(store), { headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store" } });
  }

  if (request.method === "POST" && path === "/v1/auth/link/google") {
    if (!env.GOOGLE_CLIENT_ID) return json({ error: "Google sign-in is not configured", disclaimer: DISCLAIMER }, 503);
    const body = (await request.json().catch(() => ({}))) as { credential?: string };
    const email = await googleEmail(String(body.credential ?? ""), env);
    if (!email) return json({ error: "Google sign-in was not accepted", disclaimer: DISCLAIMER }, 401);
    const owner = data.emailIndex.get(email);
    if (owner && owner !== user.id) return json({ error: "That Google account is already linked", disclaimer: DISCLAIMER }, 409);
    user.email = email;
    data.emailIndex.set(email, user.id);
    return json(view(user, adminEmails(env).has(email)));
  }
  if (request.method === "POST" && path === "/v1/auth/link/siws") {
    const body = (await request.json().catch(() => ({}))) as { pubkey?: string; signature?: string; nonce?: string };
    const nonce = data.nonces.get(String(body.nonce ?? ""));
    if (!nonce || nonce.exp < now || nonce.pubkey !== body.pubkey) return json({ error: "Login expired", disclaimer: DISCLAIMER }, 401);
    const valid = await verifyEd25519(nonce.pubkey, nonce.message, String(body.signature ?? "")).catch(() => false);
    if (!valid) return json({ error: "Login was not accepted", disclaimer: DISCLAIMER }, 401);
    data.nonces.delete(String(body.nonce));
    const owner = data.walletIndex.get(nonce.pubkey);
    if (owner && owner !== user.id) return json({ error: "That wallet is already linked", disclaimer: DISCLAIMER }, 409);
    if (!user.wallets.includes(nonce.pubkey)) user.wallets.push(nonce.pubkey);
    data.walletIndex.set(nonce.pubkey, user.id);
    return json(view(user, admin));
  }
  if (request.method === "GET" && path === "/v1/me") return json(view(user, admin));
  if (request.method === "GET" && path === "/v1/me/balances") {
    return json({ sol: null, positions: [], live: true, publicDataOnly: true, note: "Live SOL appears when a wallet is linked and an RPC key is set. No sample balance is shown as yours.", disclaimer: DISCLAIMER });
  }
  if (request.method === "GET" && path === "/v1/me/report") {
    if (user.plan !== "pro") {
      return json({
        locked: true,
        preview: "Sample report. Win rate is hidden. This is not your account and it is not a promise of profit.",
        offer: { category: "charts", title: "Chart better", disclosure: "Affiliate link · we may earn a commission" },
        disclaimer: DISCLAIMER,
      });
    }
    return json({ locked: false, winRate: null, avgHold: null, mistakes: [], offer: null, note: "Not enough closed trades for a report yet. Tips appear after you record trades. This is education, not a promise of profit.", disclaimer: DISCLAIMER });
  }
  if (request.method === "POST" && path === "/v1/me/license") {
    const body = (await request.json().catch(() => ({}))) as { key?: string };
    const key = String(body.key ?? "").trim();
    const accepted = await licenseActive(key, env);
    if (!accepted) return json({ error: "That license was not accepted", disclaimer: DISCLAIMER }, 400);
    user.plan = "pro";
    user.licenseTail = key.slice(-4);
    return json(view(user, admin));
  }
  if (request.method === "POST" && path === "/v1/me/telegram") {
    const body = (await request.json().catch(() => ({}))) as { chatId?: string };
    if (!/^\d{5,16}$/.test(String(body.chatId ?? ""))) return json({ error: "Enter the numeric chat id", disclaimer: DISCLAIMER }, 400);
    user.telegram = String(body.chatId);
    return json(view(user, admin));
  }
  if (request.method === "POST" && path === "/v1/me/keys") {
    const raw = `vh_${crypto.randomUUID().replaceAll("-", "")}`;
    const hash = await sha256(raw);
    data.apiKeys.set(hash, { userId: user.id, tail: raw.slice(-4), hash });
    store.keys.set(hash, user.plan === "pro" ? "pro" : "free");
    return json({ key: raw, tail: raw.slice(-4), once: true, disclaimer: DISCLAIMER });
  }
  if (request.method === "POST" && path === "/v1/me/keys/revoke") {
    const body = (await request.json().catch(() => ({}))) as { tail?: string };
    for (const [hash, row] of data.apiKeys) {
      if (row.userId === user.id && row.tail === body.tail) {
        data.apiKeys.delete(hash);
        store.keys.delete(hash);
      }
    }
    return json({ ok: true });
  }
  if (request.method === "GET" && path === "/v1/me/export") {
    return json({ user: view(user, admin), watchlist: data.watch.get(user.id) ?? [], disclaimer: DISCLAIMER });
  }
  if (request.method === "POST" && path === "/v1/me/sessions/revoke-others") {
    for (const [id, row] of data.sessions) if (row.userId === user.id && id !== current.row.id) data.sessions.delete(id);
    return json({ ok: true });
  }
  if (request.method === "POST" && path === "/v1/me/delete") {
    const body = (await request.json().catch(() => ({}))) as { confirm?: string };
    if (body.confirm !== "delete") return json({ error: "Type delete to confirm", disclaimer: DISCLAIMER }, 400);
    data.users.delete(user.id);
    if (user.email) data.emailIndex.delete(user.email);
    for (const pubkey of user.wallets) data.walletIndex.delete(pubkey);
    for (const [id, row] of data.sessions) if (row.userId === user.id) data.sessions.delete(id);
    return json({ ok: true }, 200, [cookie(COOKIE, "", 0, true)]);
  }
  if (request.method === "GET" && path === "/v1/admin/overview") {
    if (!admin) return json({ error: "Not an admin", disclaimer: DISCLAIMER }, 403);
    const users = [...data.users.values()];
    return json({
      users: users.map((item) => ({ email: item.email, plan: item.plan, wallets: item.wallets.length })),
      pro: users.filter((item) => item.plan === "pro").length,
      mrr: env.LEMONSQUEEZY_API_KEY ? "Connect the Lemon Squeezy API in the worker secret to load MRR." : "MRR is empty until LEMONSQUEEZY_API_KEY is set.",
      ads: "Ad network totals stay in AdMob and AdSense. Affiliate clicks are the offers list.",
      offers: await offerTotals(data, env),
      disclaimer: DISCLAIMER,
    });
  }
  return json({ error: "Not found", disclaimer: DISCLAIMER }, 404);
}

async function googleEmail(credential: string, env: BrainEnv): Promise<string | null> {
  const fetcher = env.fetchImpl ?? fetch;
  try {
    const response = await fetcher(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
    if (!response.ok) return null;
    const body = (await response.json()) as { aud?: string; email?: string; exp?: string };
    if (body.aud !== env.GOOGLE_CLIENT_ID) return null;
    if (Number(body.exp) * 1000 < Date.now()) return null;
    const email = String(body.email ?? "").toLowerCase();
    return email.includes("@") ? email : null;
  } catch {
    return null;
  }
}

async function licenseActive(key: string, env: BrainEnv): Promise<boolean> {
  if (key.length < 8) return false;
  const fetcher = env.fetchImpl ?? fetch;
  try {
    const response = await fetcher("https://api.lemonsqueezy.com/v1/licenses/validate", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ license_key: key }).toString(),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { valid?: boolean; license_key?: { status?: string }; meta?: { product_id?: number } };
    return body.valid === true && body.license_key?.status === "active" && Number(body.meta?.product_id) === PRODUCT_ID;
  } catch {
    return false;
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}
