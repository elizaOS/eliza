import type { ScoreFacts } from "./score.ts";

export interface UpstreamEnv {
  HELIUS_API_KEY?: string;
  BIRDEYE_API_KEY?: string;
}

type Fetcher = typeof fetch;

function num(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function authorityOn(value: unknown): boolean | undefined {
  if (value == null || value === false || value === "") return false;
  if (value === true) return true;
  if (typeof value === "string") return value.length > 0;
  return undefined;
}

export async function factsForMint(
  mint: string,
  env: UpstreamEnv,
  fetcher: Fetcher
): Promise<{ facts: ScoreFacts; upstream: string }> {
  const facts: ScoreFacts = {};
  const sources: string[] = [];
  const bird = (env.BIRDEYE_API_KEY ?? "").trim();
  const helius = (env.HELIUS_API_KEY ?? "").trim();
  if (!bird && !helius) return { facts, upstream: "not configured" };

  if (bird) {
    const headers = { "X-API-KEY": bird, accept: "application/json" };
    const overview = await readJson(
      fetcher,
      `https://public-api.birdeye.so/defi/token_overview?address=${encodeURIComponent(mint)}`,
      { headers }
    );
    const security = await readJson(
      fetcher,
      `https://public-api.birdeye.so/defi/token_security?address=${encodeURIComponent(mint)}`,
      { headers }
    );
    const data = asRecord(overview?.data);
    const secure = asRecord(security?.data);
    const liquidity = num(data.liquidity);
    if (liquidity != null) facts.liquidityUsd = liquidity;
    const top10 = num(secure.top10HolderPercent);
    if (top10 != null) facts.top10Pct = top10 > 1 ? top10 / 100 : top10;
    const mintAuthority = authorityOn(secure.mintAuthority ?? data.mintAuthority);
    if (mintAuthority != null) facts.mintAuthority = mintAuthority;
    const freezeAuthority = authorityOn(secure.freezeAuthority ?? data.freezeAuthority);
    if (freezeAuthority != null) facts.freezeAuthority = freezeAuthority;
    const creator = num(secure.creatorPercentage);
    if (creator != null) facts.devActive = creator > 5;
    const lock = asRecord(secure.lockInfo);
    const locked = num(lock.lockedPercent ?? secure.lockedPercent);
    if (locked != null) facts.lpLockedPct = locked;
    const change = num(data.v24hChangePercent);
    if (change != null) facts.volumeAnomaly = Math.abs(change) >= 400;
    sources.push("birdeye");
  }

  if (helius) {
    const asset = await readJson(fetcher, `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(helius)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "valhalla",
        method: "getAsset",
        params: { id: mint },
      }),
    });
    const token = asRecord(asRecord(asset?.result).token_info);
    const mintAuthority = authorityOn(token.mint_authority);
    const freezeAuthority = authorityOn(token.freeze_authority);
    if (mintAuthority != null) facts.mintAuthority = mintAuthority;
    if (freezeAuthority != null) facts.freezeAuthority = freezeAuthority;
    sources.push("helius");
  }

  return { facts, upstream: sources.join("+") || "not configured" };
}

export async function publicWalletSummary(
  pubkey: string,
  env: UpstreamEnv,
  fetcher: Fetcher
): Promise<{ sol: number | null; note: string }> {
  const helius = (env.HELIUS_API_KEY ?? "").trim();
  const rpc = helius
    ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(helius)}`
    : "https://api.mainnet-beta.solana.com";
  const body = await readJson(fetcher, rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "valhalla",
      method: "getBalance",
      params: [pubkey],
    }),
  });
  const lamports = num(asRecord(body?.result).value);
  if (lamports == null) {
    return { sol: null, note: "Public balance was not available. No private key was requested." };
  }
  return { sol: lamports / 1_000_000_000, note: "Public balance only. No private key was requested." };
}

export async function trendingMints(
  env: UpstreamEnv,
  fetcher: Fetcher
): Promise<{ items: { mint: string; symbol: string; name: string }[]; note: string }> {
  const bird = (env.BIRDEYE_API_KEY ?? "").trim();
  if (!bird) {
    return { items: [], note: "Trending is empty until Birdeye is set in the worker secrets." };
  }
  const body = await readJson(
    fetcher,
    "https://public-api.birdeye.so/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=10",
    { headers: { "X-API-KEY": bird, accept: "application/json" } }
  );
  const tokens = asRecord(body?.data).tokens;
  const items = Array.isArray(tokens)
    ? tokens.slice(0, 10).map((row) => {
        const item = asRecord(row);
        return {
          mint: String(item.address ?? item.mint ?? ""),
          symbol: String(item.symbol ?? ""),
          name: String(item.name ?? ""),
        };
      }).filter((item) => item.mint)
    : [];
  return { items, note: "Public list. Not a recommendation to buy or sell." };
}

async function readJson(fetcher: Fetcher, url: string, init: RequestInit): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(4000) });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
