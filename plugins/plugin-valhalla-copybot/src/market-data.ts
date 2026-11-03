import type { CoinSnapshot } from "./evaluate.ts";
import type { RugSummary } from "./filters.ts";
import { LIMITS } from "./limits.ts";
import type { ParsedEarlyTx } from "./manipulation.ts";
import { netTimeoutMs, withTimeout } from "./net.ts";

export { redactUrl } from "./net.ts";

export interface RpcClient {
  call(method: string, params: unknown[]): Promise<unknown>;
}

const PUBLIC_RPC = ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"];

/** Build RPC URLs from the env key. The key is never written into source. */
export function rpcEndpoints(env: Record<string, string | undefined>): string[] {
  const key = env.HELIUS_API_KEY?.trim();
  const urls = [...PUBLIC_RPC];
  if (key) urls.unshift(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`);
  return urls;
}

interface DexPair {
  baseToken?: { address?: string; symbol?: string; name?: string };
  pairCreatedAt?: number;
  fdv?: number;
  marketCap?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number; h6?: number; h1?: number; m5?: number };
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns?: { m5?: { buys?: number; sells?: number } };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function snapshotFromDex(mint: string, body: unknown): Partial<CoinSnapshot> {
  const root = asRecord(body);
  const pairs = Array.isArray(root?.pairs) ? (root.pairs as DexPair[]) : [];
  const pair = [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  if (!pair) return { mint };
  return {
    mint,
    symbol: pair.baseToken?.symbol ?? null,
    name: pair.baseToken?.name ?? null,
    pairCreatedAt: pair.pairCreatedAt ?? null,
    marketCapUsd: pair.marketCap ?? pair.fdv ?? null,
    liquidityUsd: pair.liquidity?.usd ?? null,
    volume24hUsd: pair.volume?.h24 ?? null,
    volume6hUsd: pair.volume?.h6 ?? null,
    volume1hUsd: pair.volume?.h1 ?? null,
    volume5mUsd: pair.volume?.m5 ?? null,
    change5mPct: pair.priceChange?.m5 ?? null,
    change1hPct: pair.priceChange?.h1 ?? null,
    change6hPct: pair.priceChange?.h6 ?? null,
    change24hPct: pair.priceChange?.h24 ?? null,
    buys5m: pair.txns?.m5?.buys ?? null,
    sells5m: pair.txns?.m5?.sells ?? null,
  };
}

interface RpcSig {
  signature?: string;
  slot?: number;
  err?: unknown;
}

interface RpcTx {
  slot?: number;
  meta?: {
    err?: unknown;
    preTokenBalances?: Array<{
      mint?: string;
      owner?: string;
      uiTokenAmount?: { uiAmount?: number | null };
    }>;
    postTokenBalances?: Array<{
      mint?: string;
      owner?: string;
      uiTokenAmount?: { uiAmount?: number | null };
    }>;
  };
  transaction?: { message?: { accountKeys?: Array<string | { pubkey?: string }> } };
}

export function earlyTxFromRpc(tx: RpcTx, signature: string, mint: string): ParsedEarlyTx {
  const keys = tx.transaction?.message?.accountKeys ?? [];
  const first = keys[0];
  const feePayer = typeof first === "string" ? first : (first?.pubkey ?? null);
  const pre = new Map<string, number>();
  for (const bal of tx.meta?.preTokenBalances ?? []) {
    if (bal.mint === mint && bal.owner)
      pre.set(bal.owner, Number(bal.uiTokenAmount?.uiAmount ?? 0));
  }
  const increases: ParsedEarlyTx["increases"] = [];
  for (const bal of tx.meta?.postTokenBalances ?? []) {
    if (bal.mint !== mint || !bal.owner) continue;
    const after = Number(bal.uiTokenAmount?.uiAmount ?? 0);
    const before = pre.get(bal.owner) ?? 0;
    if (after > before) increases.push({ owner: bal.owner, before, after });
  }
  return {
    signature,
    slot: tx.slot ?? null,
    err: Boolean(tx.meta?.err),
    feePayer,
    increases,
  };
}

export async function loadEarlyTxs(mint: string, rpc: RpcClient): Promise<ParsedEarlyTx[]> {
  const sigs = (await rpc.call("getSignaturesForAddress", [mint, { limit: 40 }])) as
    | RpcSig[]
    | null;
  if (!Array.isArray(sigs)) return [];
  const out: ParsedEarlyTx[] = [];
  for (const sig of sigs.slice(0, 25)) {
    if (!sig.signature) continue;
    const tx = (await rpc.call("getTransaction", [
      sig.signature,
      { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" },
    ])) as RpcTx | null;
    if (!tx) continue;
    out.push(earlyTxFromRpc({ ...tx, slot: tx.slot ?? sig.slot }, sig.signature, mint));
  }
  return out;
}

export function rugFromReport(body: unknown): RugSummary | null {
  const row = asRecord(body);
  if (!row) return null;
  const holders = Array.isArray(row.topHolders) ? row.topHolders : [];
  return {
    score: Number(row.score ?? row.score_normalised ?? 0),
    mintAuthority: (row.mintAuthority as string | null) ?? null,
    freezeAuthority: (row.freezeAuthority as string | null) ?? null,
    risks: Array.isArray(row.risks) ? (row.risks as RugSummary["risks"]) : [],
    topHolders: holders as RugSummary["topHolders"],
    markets: Array.isArray(row.markets) ? (row.markets as RugSummary["markets"]) : [],
    rugged: row.rugged === true,
    creator: (row.creator as string | null) ?? null,
    creatorTokens: Array.isArray(row.creatorTokens)
      ? (row.creatorTokens as RugSummary["creatorTokens"])
      : [],
  };
}

export async function fetchMarkPrice(
  mint: string,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch
): Promise<number | null> {
  try {
    const body = await httpJson(
      `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`,
      fetchImpl
    );
    const pairs = (body as { pairs?: Array<{ priceUsd?: string }> } | null)?.pairs ?? [];
    const price = Number(pairs[0]?.priceUsd);
    if (price > 0) return price;
  } catch {
    // DexScreener miss falls through to Birdeye when a key is set.
  }
  const key = (env.BIRDEYE_API_KEY || env.BIRDEYE || "").trim();
  if (!key) return null;
  const response = await fetchImpl(
    `https://public-api.birdeye.so/defi/price?address=${encodeURIComponent(mint)}`,
    { headers: { accept: "application/json", "X-API-KEY": key } }
  );
  if (!response.ok) return null;
  const payload = (await response.json()) as { data?: { value?: number } };
  const value = Number(payload.data?.value);
  return value > 0 ? value : null;
}

export async function httpJson(url: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const response = await withTimeout(
    fetchImpl(url, { headers: { accept: "application/json" } }),
    netTimeoutMs(),
    "price feed"
  );
  if (!response.ok) throw new Error(`HTTP ${response.status} ${redactUrl(url)}`);
  return response.json() as Promise<unknown>;
}

export async function loadCoinSnapshot(
  mint: string,
  deps: { fetchImpl?: typeof fetch; rpc: RpcClient }
): Promise<CoinSnapshot> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const dex = await httpJson(
    `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`,
    fetchImpl
  );
  const partial = snapshotFromDex(mint, dex);
  let rug: RugSummary | null = null;
  try {
    rug = rugFromReport(
      await httpJson(
        `https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(mint)}/report`,
        fetchImpl
      )
    );
  } catch {
    rug = null;
  }
  const earlyTxs = await loadEarlyTxs(mint, deps.rpc);
  const holders = (rug?.topHolders ?? []).map((holder) => ({
    address: holder.address ?? holder.owner ?? null,
    owner: holder.owner ?? null,
    pct: holder.pct ?? null,
  }));
  return {
    ...partial,
    mint,
    creator: rug?.creator ?? null,
    rug,
    mr: null,
    earlyTxs,
    holders,
    mintAuthority: rug?.mintAuthority ?? null,
    freezeAuthority: rug?.freezeAuthority ?? null,
    quoteSol: LIMITS.dynMinTicketSol,
  };
}
