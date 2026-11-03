import { netTimeoutMs, withTimeout } from "./net.ts";

export type PriceSource = "birdeye" | "helius" | "dexscreener";

const waitUntil = new Map<PriceSource, number>();

export function priceOrder(hasBirdeye: boolean, hasHelius: boolean): PriceSource[] {
  const order: PriceSource[] = [];
  if (hasBirdeye) order.push("birdeye");
  if (hasHelius) order.push("helius");
  order.push("dexscreener");
  return order;
}

async function getJson(
  url: string,
  fetchImpl: typeof fetch,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown }> {
  const response = await withTimeout(
    fetchImpl(url, { headers: { accept: "application/json", ...headers } }),
    netTimeoutMs(),
    "price feed"
  );
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

function numberFrom(value: unknown): number | null {
  const price = Number(value);
  return price > 0 ? price : null;
}

/** Try each source in order. A 429 waits that source out and moves on. */
export async function fetchTokenPrice(
  mint: string,
  order: PriceSource[],
  keys: { birdeye?: string; helius?: string },
  fetchImpl: typeof fetch = fetch,
  now = Date.now()
): Promise<{ price: number | null; source: PriceSource | null; limited: string[] }> {
  const limited: string[] = [];
  for (const source of order) {
    if ((waitUntil.get(source) ?? 0) > now) {
      limited.push(source);
      continue;
    }
    try {
      const hit = await readSource(source, mint, keys, fetchImpl);
      if (hit.status === 429) {
        waitUntil.set(source, now + 1_000);
        limited.push(source);
        continue;
      }
      const price = hit.price;
      if (price) return { price, source, limited };
    } catch {
      // This source failed. The next one in the order still runs.
    }
  }
  return { price: null, source: null, limited };
}

async function readSource(
  source: PriceSource,
  mint: string,
  keys: { birdeye?: string; helius?: string },
  fetchImpl: typeof fetch
): Promise<{ status: number; price: number | null }> {
  if (source === "dexscreener") {
    const hit = await getJson(
      `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`,
      fetchImpl
    );
    const pairs = (hit.body as { pairs?: Array<{ priceUsd?: string }> } | null)?.pairs ?? [];
    return { status: hit.status, price: numberFrom(pairs[0]?.priceUsd) };
  }
  if (source === "birdeye") {
    const hit = await getJson(
      `https://public-api.birdeye.so/defi/price?address=${encodeURIComponent(mint)}`,
      fetchImpl,
      { "X-API-KEY": keys.birdeye ?? "" }
    );
    const value = (hit.body as { data?: { value?: number } } | null)?.data?.value;
    return { status: hit.status, price: numberFrom(value) };
  }
  const hit = await getJson(
    `https://api.helius.xyz/v0/token-metadata?api-key=${encodeURIComponent(keys.helius ?? "")}`,
    fetchImpl,
    { "content-type": "application/json" }
  );
  const row = Array.isArray(hit.body) ? (hit.body[0] as { priceUsd?: number }) : null;
  return { status: hit.status, price: numberFrom(row?.priceUsd) };
}
