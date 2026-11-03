import { encodeBase58 } from "./base58.ts";
import { DISCLAIMER } from "./score.ts";
import type { BrainEnv, MemoryStore } from "./worker.ts";

/** Must match extension/trust.js. Crypto checkout stays off when this verify fails. */
const PUBLIC_KEY_B64 = "XZuPtlchqj37JLDx3ssEjztngYqhPjItESZEURBDY9A=";

export type PlanId = "monthly" | "yearly" | "lifetime";
export type PayAsset = "usdc" | "sol";
export type Judge =
  | "ok"
  | "wrong-amount"
  | "wrong-mint"
  | "wrong-recipient"
  | "unconfirmed"
  | "expired"
  | "replay"
  | "missing-reference";

export interface PayConfig {
  cryptoReceiveAddress: string;
  usdcMint: string;
  priceMonthlyUsd: number;
  priceYearlyUsd: number;
  priceLifetimeUsd: number;
}

export interface CryptoOrder {
  id: string;
  userId: string;
  emailHash: string;
  plan: PlanId;
  asset: PayAsset;
  amountBase: string;
  mint: string;
  reference: string;
  recipient: string;
  createdAt: number;
  expiresAt: number;
  status: "open" | "paid" | "review";
  reason?: string;
}

export interface ObservedTransfer {
  signature: string;
  commitment: "processed" | "confirmed" | "finalized";
  recipient: string;
  amountBase: string;
  mint: string;
  references: string[];
}

export interface CryptoReceipt {
  orderId: string;
  emailHash: string;
  plan: PlanId;
  amountBase: string;
  mint: string;
  signature: string;
  paidAt: number;
}

interface CryptoState {
  orders: Map<string, CryptoOrder>;
  receipts: CryptoReceipt[];
  seen: Set<string>;
}

function stateOf(store: MemoryStore): CryptoState {
  if (!store.crypto) store.crypto = { orders: new Map(), receipts: [], seen: new Set() };
  return store.crypto as CryptoState;
}

function offerRow(row: {
  id: string;
  partner: string;
  title: string;
  blurb: string;
  url?: string;
  image?: string;
  placements?: string[];
  tier: string;
  category: string;
  disclosure: string;
}) {
  return {
    id: String(row.id),
    partner: String(row.partner),
    title: String(row.title),
    blurb: String(row.blurb),
    url: String(row.url || ""),
    image: String(row.image || ""),
    placements: row.placements || [],
    tier: row.tier,
    category: row.category,
    disclosure: row.disclosure,
  };
}

export function canonicalMonetization(doc: Record<string, unknown>): string {
  const offers = Array.isArray(doc.offers) ? doc.offers : [];
  return JSON.stringify({
    adsenseClient: String(doc.adsenseClient || ""),
    admobPublisher: String(doc.admobPublisher || ""),
    admobAppId: String(doc.admobAppId || ""),
    admobBannerAndroid: String(doc.admobBannerAndroid || ""),
    admobBannerIos: String(doc.admobBannerIos || ""),
    admobInterstitialAndroid: String(doc.admobInterstitialAndroid || ""),
    admobRewardedAndroid: String(doc.admobRewardedAndroid || ""),
    admobRewardedIos: String(doc.admobRewardedIos || ""),
    checkoutUrl: String(doc.checkoutUrl || ""),
    checkoutYearlyUrl: String(doc.checkoutYearlyUrl || ""),
    checkoutLifetimeUrl: String(doc.checkoutLifetimeUrl || ""),
    cryptoReceiveAddress: String(doc.cryptoReceiveAddress || ""),
    usdcMint: String(doc.usdcMint || ""),
    priceMonthlyUsd: Number(doc.priceMonthlyUsd),
    priceYearlyUsd: Number(doc.priceYearlyUsd),
    priceLifetimeUsd: Number(doc.priceLifetimeUsd),
    proTradeAllowance: Number(doc.proTradeAllowance),
    trialDays: Number(doc.trialDays),
    offers: offers.map((row) => offerRow(row as Parameters<typeof offerRow>[0])),
  });
}

export async function verifyMonetization(doc: Record<string, unknown> | null): Promise<PayConfig | null> {
  if (!doc || typeof doc.signature !== "string" || !doc.cryptoReceiveAddress || !doc.usdcMint) return null;
  try {
    const raw = Uint8Array.from(atob(PUBLIC_KEY_B64), (char) => char.charCodeAt(0));
    const sig = Uint8Array.from(atob(doc.signature), (char) => char.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("Ed25519", key, sig, new TextEncoder().encode(canonicalMonetization(doc)));
    if (!ok) return null;
    return {
      cryptoReceiveAddress: String(doc.cryptoReceiveAddress),
      usdcMint: String(doc.usdcMint),
      priceMonthlyUsd: Number(doc.priceMonthlyUsd),
      priceYearlyUsd: Number(doc.priceYearlyUsd),
      priceLifetimeUsd: Number(doc.priceLifetimeUsd),
    };
  } catch {
    return null;
  }
}

export function priceFor(config: PayConfig, plan: PlanId): number {
  if (plan === "yearly") return config.priceYearlyUsd;
  if (plan === "lifetime") return config.priceLifetimeUsd;
  return config.priceMonthlyUsd;
}

export function usdcBase(usd: number): string {
  return String(Math.round(usd * 1_000_000));
}

export function solBase(usd: number, solPriceUsd: number): string {
  if (!Number.isFinite(solPriceUsd) || solPriceUsd <= 0) return "0";
  return String(Math.round((usd / solPriceUsd) * 1_000_000_000));
}

export function newReference(): string {
  return encodeBase58(crypto.getRandomValues(new Uint8Array(32)));
}

export function solanaPayUrl(order: CryptoOrder): string {
  const whole = order.mint === "SOL" ? Number(order.amountBase) / 1_000_000_000 : Number(order.amountBase) / 1_000_000;
  const amount = whole.toFixed(order.mint === "SOL" ? 9 : 6).replace(/\.?0+$/, "");
  const url = new URL(`solana:${order.recipient}`);
  url.searchParams.set("amount", amount);
  if (order.mint !== "SOL") url.searchParams.set("spl-token", order.mint);
  url.searchParams.set("reference", order.reference);
  url.searchParams.set("label", "Valhalla Pro");
  url.searchParams.set("message", `${order.plan}. Refunds are manual.`);
  return url.toString();
}

export function walletLinks(payUrl: string): { phantom: string; solflare: string } {
  const params = new URL(payUrl).searchParams;
  const recipient = payUrl.slice("solana:".length).split("?")[0];
  const query = new URLSearchParams({
    recipient,
    amount: params.get("amount") || "",
    reference: params.get("reference") || "",
    label: params.get("label") || "Valhalla Pro",
    message: params.get("message") || "Refunds are manual.",
  });
  const mint = params.get("spl-token");
  if (mint) query.set("spl-token", mint);
  return {
    phantom: `https://phantom.app/ul/v1/pay?${query}`,
    solflare: `https://solflare.com/ul/v1/pay?${query}`,
  };
}

export function judgePayment(order: CryptoOrder, transfer: ObservedTransfer, seen: Set<string>, now: number): Judge {
  if (seen.has(transfer.signature)) return "replay";
  if (transfer.commitment !== "confirmed" && transfer.commitment !== "finalized") return "unconfirmed";
  if (now > order.expiresAt) return "expired";
  if (transfer.recipient !== order.recipient) return "wrong-recipient";
  if (transfer.mint !== order.mint) return "wrong-mint";
  if (BigInt(transfer.amountBase) !== BigInt(order.amountBase)) return "wrong-amount";
  if (!transfer.references.includes(order.reference)) return "missing-reference";
  return "ok";
}

export function licenseUntil(plan: PlanId, now: number): number | null {
  if (plan === "monthly") return now + 30 * 24 * 60 * 60 * 1000;
  if (plan === "yearly") return now + 365 * 24 * 60 * 60 * 1000;
  return null;
}

export function applyPayment(
  store: MemoryStore,
  order: CryptoOrder,
  transfer: ObservedTransfer,
  now: number
): { judge: Judge; until: number | null } {
  const box = stateOf(store);
  const judge = judgePayment(order, transfer, box.seen, now);
  if (judge === "replay") return { judge, until: null };
  if (judge !== "ok") {
    order.status = "review";
    order.reason = judge;
    box.orders.set(order.id, order);
    return { judge, until: null };
  }
  box.seen.add(transfer.signature);
  order.status = "paid";
  order.reason = undefined;
  box.orders.set(order.id, order);
  box.receipts.push({
    orderId: order.id,
    emailHash: order.emailHash,
    plan: order.plan,
    amountBase: order.amountBase,
    mint: order.mint,
    signature: transfer.signature,
    paidAt: now,
  });
  return { judge, until: licenseUntil(order.plan, now) };
}

export function receiptsCsv(store: MemoryStore): string {
  const lines = ["order_id,email_hash,plan,amount_base,mint,tx_signature,paid_at"];
  for (const row of stateOf(store).receipts) {
    lines.push([row.orderId, row.emailHash, row.plan, row.amountBase, row.mint, row.signature, new Date(row.paidAt).toISOString()].join(","));
  }
  return `${lines.join("\n")}\n`;
}

async function emailHash(email: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.toLowerCase()));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

export async function openOrder(
  store: MemoryStore,
  input: { userId: string; email: string; plan: PlanId; asset: PayAsset; config: PayConfig; solPriceUsd?: number; now?: number }
): Promise<CryptoOrder | null> {
  if (!input.email.includes("@")) return null;
  const usd = priceFor(input.config, input.plan);
  if (!Number.isFinite(usd) || usd <= 0 || !input.config.cryptoReceiveAddress) return null;
  const now = input.now ?? Date.now();
  const sol = input.asset === "sol";
  const amountBase = sol ? solBase(usd, input.solPriceUsd || 0) : usdcBase(usd);
  if (amountBase === "0") return null;
  const order: CryptoOrder = {
    id: crypto.randomUUID(),
    userId: input.userId,
    emailHash: await emailHash(input.email),
    plan: input.plan,
    asset: input.asset,
    amountBase,
    mint: sol ? "SOL" : input.config.usdcMint,
    reference: newReference(),
    recipient: input.config.cryptoReceiveAddress,
    createdAt: now,
    expiresAt: now + (sol ? 10 : 24 * 60) * 60 * 1000,
    status: "open",
  };
  stateOf(store).orders.set(order.id, order);
  return order;
}

const ORDER_SQL = `CREATE TABLE IF NOT EXISTS crypto_orders (
  id TEXT PRIMARY KEY, user_id TEXT, email_hash TEXT, plan TEXT, asset TEXT,
  amount_base TEXT, mint TEXT, reference TEXT, recipient TEXT,
  created_at INTEGER, expires_at INTEGER, status TEXT, reason TEXT
)`;
const RECEIPT_SQL = `CREATE TABLE IF NOT EXISTS crypto_receipts (
  signature TEXT PRIMARY KEY, order_id TEXT, email_hash TEXT, plan TEXT,
  amount_base TEXT, mint TEXT, paid_at INTEGER
)`;

export async function persistCrypto(env: BrainEnv, store: MemoryStore): Promise<void> {
  if (!env.DB) return;
  const box = stateOf(store);
  await env.DB.prepare(ORDER_SQL).run();
  await env.DB.prepare(RECEIPT_SQL).run();
  for (const order of box.orders.values()) {
    await env.DB.prepare(
      `INSERT INTO crypto_orders (id, user_id, email_hash, plan, asset, amount_base, mint, reference, recipient, created_at, expires_at, status, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, reason = excluded.reason`
    )
      .bind(order.id, order.userId, order.emailHash, order.plan, order.asset, order.amountBase, order.mint, order.reference, order.recipient, order.createdAt, order.expiresAt, order.status, order.reason || "")
      .run();
  }
  for (const row of box.receipts) {
    await env.DB.prepare(
      `INSERT INTO crypto_receipts (signature, order_id, email_hash, plan, amount_base, mint, paid_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(signature) DO NOTHING`
    )
      .bind(row.signature, row.orderId, row.emailHash, row.plan, row.amountBase, row.mint, row.paidAt)
      .run();
  }
}

export function rpcUrl(env: BrainEnv): string {
  const key = env.HELIUS_API_KEY?.trim();
  if (key) return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
  return "https://api.mainnet-beta.solana.com";
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ...((body as object) || {}), disclaimer: DISCLAIMER }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export function orderView(order: CryptoOrder) {
  const payUrl = solanaPayUrl(order);
  const links = walletLinks(payUrl);
  return {
    id: order.id,
    plan: order.plan,
    asset: order.asset,
    amountBase: order.amountBase,
    mint: order.mint,
    recipientTail: order.recipient.slice(-4),
    referenceTail: order.reference.slice(-4),
    expiresAt: new Date(order.expiresAt).toISOString(),
    status: order.status,
    reason: order.reason || "",
    payUrl,
    phantom: links.phantom,
    solflare: links.solflare,
    refunds: "Refunds are manual.",
  };
}

export async function readPayConfig(env: BrainEnv): Promise<PayConfig | null> {
  const fetcher = env.fetchImpl ?? fetch;
  const url = env.MONETIZATION_URL || "https://valhalla-app.xyz/monetization.json";
  try {
    const response = await fetcher(url);
    if (!response.ok) return null;
    return verifyMonetization((await response.json()) as Record<string, unknown>);
  } catch {
    return null;
  }
}

export { json as cryptoJson };

interface ParsedInstruction {
  program?: string;
  parsed?: { type?: string; info?: Record<string, unknown> };
}

export function observedFromParsed(tx: {
  signature: string;
  commitment: ObservedTransfer["commitment"];
  accountKeys?: string[];
  instructions?: ParsedInstruction[];
  tokenOwners?: Record<string, string>;
}): ObservedTransfer[] {
  const references = tx.accountKeys || [];
  const out: ObservedTransfer[] = [];
  for (const ix of tx.instructions || []) {
    const info = ix.parsed?.info || {};
    const type = ix.parsed?.type || "";
    if (ix.program === "system" && type === "transfer") {
      out.push({
        signature: tx.signature,
        commitment: tx.commitment,
        recipient: String(info.destination || ""),
        amountBase: String(info.lamports || "0"),
        mint: "SOL",
        references,
      });
    }
    if (ix.program === "spl-token" && (type === "transfer" || type === "transferChecked")) {
      const destination = String(info.destination || "");
      const tokenAmount = info.tokenAmount as { amount?: string } | undefined;
      out.push({
        signature: tx.signature,
        commitment: tx.commitment,
        recipient: tx.tokenOwners?.[destination] || "",
        amountBase: String(tokenAmount?.amount || info.amount || "0"),
        mint: String(info.mint || ""),
        references,
      });
    }
  }
  return out;
}

async function rpcCall(env: BrainEnv, method: string, params: unknown[]): Promise<unknown> {
  const fetcher = env.fetchImpl ?? fetch;
  const response = await fetcher(rpcUrl(env), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { result?: unknown };
  return body.result ?? null;
}

export async function pollCryptoOrders(store: MemoryStore, env: BrainEnv, now = Date.now()): Promise<number> {
  const config = await readPayConfig(env);
  if (!config) return 0;
  let paid = 0;
  for (const order of stateOf(store).orders.values()) {
    if (order.status !== "open") continue;
    if (order.recipient !== config.cryptoReceiveAddress) {
      order.status = "review";
      order.reason = "wrong-recipient";
      continue;
    }
    const sigs = (await rpcCall(env, "getSignaturesForAddress", [order.reference, { commitment: "confirmed", limit: 5 }])) as
      | Array<{ signature?: string; confirmationStatus?: string }>
      | null;
    for (const row of sigs || []) {
      if (!row.signature) continue;
      const parsed = (await rpcCall(env, "getTransaction", [
        row.signature,
        { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
      ])) as {
        transaction?: { message?: { accountKeys?: Array<string | { pubkey?: string }>; instructions?: ParsedInstruction[] } };
        meta?: { innerInstructions?: Array<{ instructions?: ParsedInstruction[] }> };
      } | null;
      const keys = (parsed?.transaction?.message?.accountKeys || []).map((key) => (typeof key === "string" ? key : key.pubkey || ""));
      const instructions = [
        ...(parsed?.transaction?.message?.instructions || []),
        ...(parsed?.meta?.innerInstructions || []).flatMap((inner) => inner.instructions || []),
      ];
      const owners: Record<string, string> = {};
      for (const ix of instructions) {
        const destination = String(ix.parsed?.info?.destination || "");
        if (!destination || ix.program !== "spl-token") continue;
        const account = (await rpcCall(env, "getAccountInfo", [destination, { encoding: "jsonParsed" }])) as {
          value?: { data?: { parsed?: { info?: { owner?: string } } } };
        } | null;
        const owner = account?.value?.data?.parsed?.info?.owner;
        if (owner) owners[destination] = owner;
      }
      const commitment = row.confirmationStatus === "finalized" ? "finalized" : "confirmed";
      for (const transfer of observedFromParsed({
        signature: row.signature,
        commitment,
        accountKeys: keys,
        instructions,
        tokenOwners: owners,
      })) {
        const result = applyPayment(store, order, transfer, now);
        if (result.judge === "ok") {
          const user = store.portal?.users.get(order.userId) as { plan: "free" | "pro"; cryptoUntil?: number | null } | undefined;
          if (user) {
            user.plan = "pro";
            user.cryptoUntil = result.until;
          }
          paid += 1;
        }
      }
    }
  }
  await persistCrypto(env, store);
  return paid;
}
