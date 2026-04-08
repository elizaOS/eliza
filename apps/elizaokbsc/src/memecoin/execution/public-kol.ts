import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ethers } from "ethers";
import type { ExecutionConfig } from "../types";

const TRANSFER_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
] as const;
const GMGN_PUBLIC_BASE = "https://gmgn.ai/defi/quotation/v1";

interface KolWalletEntry {
  label: string | undefined;
  address: string;
}

interface GmgnRankToken {
  address?: string;
}

interface GmgnRankResponse {
  code?: number;
  data?: {
    rank?: GmgnRankToken[];
  };
}

const GMGN_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
} as const;

function normalizeAddress(value: string): string | null {
  try {
    return ethers.getAddress(value);
  } catch {
    return null;
  }
}

function cachePathFor(config: ExecutionConfig): string | null {
  const raw = config.kol.publicCachePath?.trim();
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
}

async function loadCachedWallets(
  config: ExecutionConfig,
): Promise<KolWalletEntry[]> {
  const cachePath = cachePathFor(config);
  if (!cachePath) return [];

  try {
    const content = await readFile(cachePath, "utf8");
    const parsed = JSON.parse(content) as Array<{
      label?: string;
      address?: string;
    }>;
    return parsed
      .map((entry) => {
        const normalized = entry.address
          ? normalizeAddress(entry.address)
          : null;
        if (!normalized) return null;
        return { label: entry.label, address: normalized };
      })
      .filter((entry): entry is KolWalletEntry => entry !== null);
  } catch {
    return [];
  }
}

async function saveCachedWallets(
  config: ExecutionConfig,
  wallets: KolWalletEntry[],
): Promise<void> {
  const cachePath = cachePathFor(config);
  if (!cachePath) return;

  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(wallets, null, 2), "utf8");
}

async function fetchRankAddresses(
  orderby: "smartmoney" | "holder_count" | "swaps",
  limit: number,
): Promise<string[]> {
  const url =
    `${GMGN_PUBLIC_BASE}/rank/bsc/swaps/24h?orderby=${orderby}&direction=desc` +
    `&filters[]=not_honeypot&filters[]=verified&filters[]=renounced`;
  const response = await fetch(url, { headers: GMGN_HEADERS });
  if (!response.ok) {
    throw new Error(
      `GMGN public ${orderby} rank request failed: ${response.status} ${response.statusText}`,
    );
  }

  const payload = (await response.json()) as GmgnRankResponse;
  const rank = payload.data?.rank ?? [];
  return rank
    .map((item) => item.address)
    .map((value) => (value ? normalizeAddress(value) : null))
    .filter((value): value is string => Boolean(value))
    .slice(0, limit);
}

async function fetchCandidateTokenUniverse(
  config: ExecutionConfig,
): Promise<string[]> {
  const [smartMoney, holders, swaps] = await Promise.allSettled([
    fetchRankAddresses("smartmoney", config.kol.publicSourceTokenLimit),
    fetchRankAddresses("holder_count", config.kol.publicSourceTokenLimit),
    fetchRankAddresses("swaps", config.kol.publicSourceTokenLimit),
  ]);

  return Array.from(
    new Set(
      [smartMoney, holders, swaps]
        .flatMap((result) =>
          result.status === "fulfilled" ? result.value : [],
        )
        .filter((value): value is string => Boolean(value)),
    ),
  );
}

export async function collectPublicKolWallets(
  config: ExecutionConfig,
  seedTokenAddresses: string[] = [],
): Promise<KolWalletEntry[]> {
  if (!config.kol.publicSourceEnabled || !config.rpcUrl) {
    return [];
  }

  try {
    const provider = new ethers.JsonRpcProvider(config.rpcUrl);
    const latestBlock = await provider.getBlockNumber();
    const publicUniverse = await fetchCandidateTokenUniverse(config);
    const tokenAddresses = Array.from(
      new Set(
        [...publicUniverse, ...seedTokenAddresses]
          .map((value) => normalizeAddress(value))
          .filter((value): value is string => Boolean(value)),
      ),
    );
    if (tokenAddresses.length === 0) {
      return loadCachedWallets(config);
    }

    const iface = new ethers.Interface(TRANSFER_ABI);
    const hitCounts = new Map<string, number>();

    for (const tokenAddress of tokenAddresses) {
      try {
        const logs = await provider.getLogs({
          address: tokenAddress,
          fromBlock: Math.max(
            0,
            latestBlock - config.kol.publicSourceLookbackBlocks,
          ),
          toBlock: latestBlock,
          topics: [ethers.id("Transfer(address,address,uint256)")],
        });

        const localAddresses = new Set<string>();
        for (const log of logs.slice(-300)) {
          try {
            const parsed = iface.parseLog(log);
            const to = normalizeAddress(String(parsed?.args?.to ?? ""));
            if (!to || to === ethers.ZeroAddress) continue;
            localAddresses.add(to);
          } catch {
            // Ignore undecodable logs.
          }
        }

        for (const address of localAddresses) {
          hitCounts.set(address, (hitCounts.get(address) ?? 0) + 1);
        }
      } catch {
        // Skip tokens that fail log queries and continue.
      }
    }

    const ranked = Array.from(hitCounts.entries())
      .filter(([, hits]) => hits >= config.kol.publicSourceMinTokenHits)
      .sort((a, b) => b[1] - a[1])
      .slice(0, config.kol.publicSourceWalletLimit * 3);

    const wallets: KolWalletEntry[] = [];
    for (const [address, hits] of ranked) {
      try {
        const code = await provider.getCode(address);
        if (code !== "0x") continue;
        wallets.push({
          label: `public-kol-hits-${hits}`,
          address,
        });
        if (wallets.length >= config.kol.publicSourceWalletLimit) break;
      } catch {
        // Ignore addresses that fail code checks.
      }
    }

    if (wallets.length > 0) {
      await saveCachedWallets(config, wallets);
      return wallets;
    }

    return loadCachedWallets(config);
  } catch {
    return loadCachedWallets(config);
  }
}

export async function warmPublicKolWallets(
  config: ExecutionConfig,
  seedTokenAddresses: string[] = [],
): Promise<KolWalletEntry[]> {
  return collectPublicKolWallets(config, seedTokenAddresses);
}
