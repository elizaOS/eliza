import { db, eq, inArray, nftOwnership, users } from '@babylon/db';
import { ValidationError } from '@babylon/shared';
import { getNftChainId } from './nft/nft-chain';

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

export class NftIndexerUnavailableError extends Error {
  constructor(
    message: string,
    public cause?: unknown
  ) {
    super(message);
    this.name = 'NftIndexerUnavailableError';
  }
}

function normalizeHexAddress(address: string): string {
  const trimmed = address.trim();
  if (!trimmed) return '';
  if (!trimmed.startsWith('0x') && !trimmed.startsWith('0X')) return trimmed;
  return `0x${trimmed.slice(2).toLowerCase()}`;
}

function getNftIndexerGraphqlUrl(): string | null {
  const url = process.env.NFT_INDEXER_GRAPHQL_URL?.trim();
  return url && url.length > 0 ? url : null;
}

export function getNftCollectionIdFromEnv(): string {
  const contractAddressRaw = process.env.NFT_CONTRACT_ADDRESS?.trim();

  const chainId = getNftChainId();

  if (!contractAddressRaw) {
    throw new ValidationError(
      'NFT_CONTRACT_ADDRESS not configured',
      ['NFT_CONTRACT_ADDRESS'],
      [{ field: 'NFT_CONTRACT_ADDRESS', message: 'Must be set' }]
    );
  }

  const contractAddress = normalizeHexAddress(contractAddressRaw);
  if (!/^0x[0-9a-f]{40}$/.test(contractAddress)) {
    throw new ValidationError(
      'NFT_CONTRACT_ADDRESS is invalid',
      ['NFT_CONTRACT_ADDRESS'],
      [{ field: 'NFT_CONTRACT_ADDRESS', message: 'Must be a valid address' }]
    );
  }

  return `${chainId}_${contractAddress}`;
}

type CachedAccess = { allowed: boolean; expiresAtMs: number };
const accessCache = new Map<string, CachedAccess>();

const DEFAULT_POSITIVE_TTL_MS = 10_000;
const DEFAULT_NEGATIVE_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 2_500;
const MAX_CACHE_ENTRIES = 10_000;
const MAX_TTL_MS = 5 * 60_000;

export type HasOnchainNftAccessOptions = {
  /**
   * Cache scope to prevent one call site from affecting another.
   * Example: "premium_chat" vs "default".
   */
  cacheScope?: string;
  /**
   * Overrides the internal in-memory cache TTLs. Values are clamped.
   */
  positiveTtlMs?: number;
  negativeTtlMs?: number;
  /**
   * When true, bypasses the in-memory cache entirely.
   */
  bypassCache?: boolean;
};

/**
 * Evicts expired entries and enforces size cap on the cache.
 * Uses FIFO eviction when size exceeds MAX_CACHE_ENTRIES.
 */
function evictExpiredCacheEntries(nowMs: number): void {
  // Evict expired entries
  for (const [key, value] of accessCache) {
    if (value.expiresAtMs <= nowMs) {
      accessCache.delete(key);
    }
  }

  // Enforce size cap with FIFO eviction
  while (accessCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = accessCache.keys().next().value;
    if (oldestKey) accessCache.delete(oldestKey);
    else break;
  }
}

function normalizeTtlMs(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), MAX_TTL_MS);
}

function getCacheTtls(opts?: HasOnchainNftAccessOptions): {
  positiveTtlMs: number;
  negativeTtlMs: number;
} {
  return {
    positiveTtlMs: normalizeTtlMs(opts?.positiveTtlMs, DEFAULT_POSITIVE_TTL_MS),
    negativeTtlMs: normalizeTtlMs(opts?.negativeTtlMs, DEFAULT_NEGATIVE_TTL_MS),
  };
}

async function fetchGraphql<TData extends JsonObject>(
  url: string,
  payload: { query: string; variables?: JsonObject }
): Promise<TData> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const json = (await res.json()) as unknown;
    if (!res.ok) {
      throw new NftIndexerUnavailableError(
        `Indexer returned HTTP ${res.status}`,
        json
      );
    }

    if (!json || typeof json !== 'object') {
      throw new NftIndexerUnavailableError(
        'Indexer returned non-JSON response'
      );
    }

    const obj = json as { data?: TData; errors?: unknown };
    if (obj.errors) {
      throw new NftIndexerUnavailableError(
        'Indexer GraphQL errors',
        obj.errors
      );
    }
    if (!obj.data) {
      throw new NftIndexerUnavailableError('Indexer response missing data');
    }

    return obj.data;
  } catch (error) {
    if (error instanceof NftIndexerUnavailableError) throw error;
    throw new NftIndexerUnavailableError('Failed to reach indexer', error);
  } finally {
    clearTimeout(timeout);
  }
}

type HolderBalanceQueryData = {
  NftHolder: Array<{ balance: string }>;
};

export async function getNftHolderBalanceFromIndexer(
  walletAddress: string
): Promise<bigint> {
  const url = getNftIndexerGraphqlUrl();
  if (!url) {
    throw new NftIndexerUnavailableError(
      'NFT_INDEXER_GRAPHQL_URL not configured'
    );
  }

  let collectionId: string;
  try {
    collectionId = getNftCollectionIdFromEnv();
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new NftIndexerUnavailableError(
        'NFT collection config not valid',
        error
      );
    }
    throw error;
  }
  const address = normalizeHexAddress(walletAddress);

  const data = await fetchGraphql<HolderBalanceQueryData>(url, {
    query:
      'query($cid:String!,$addr:String!){NftHolder(where:{collection_id:{_eq:$cid},address:{_eq:$addr}},limit:1){balance}}',
    variables: { cid: collectionId, addr: address },
  });

  const row = data.NftHolder[0];
  if (!row) return 0n;
  const balance = BigInt(row.balance);
  return balance;
}

export async function hasOnchainNftAccess(
  walletAddress: string,
  opts?: HasOnchainNftAccessOptions
): Promise<boolean> {
  let collectionId: string;
  try {
    collectionId = getNftCollectionIdFromEnv();
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new NftIndexerUnavailableError(
        'NFT collection config not valid',
        error
      );
    }
    throw error;
  }
  const address = normalizeHexAddress(walletAddress);
  const cacheScope = opts?.cacheScope?.trim() || 'default';
  const cacheKey = `${cacheScope}:${collectionId}:${address}`;

  if (opts?.bypassCache === true) {
    const balance = await getNftHolderBalanceFromIndexer(address);
    return balance > 0n;
  }

  const nowMs = Date.now();
  const cached = accessCache.get(cacheKey);
  if (cached) {
    if (cached.expiresAtMs > nowMs) {
      return cached.allowed;
    }
    // Delete expired entry
    accessCache.delete(cacheKey);
  }

  const balance = await getNftHolderBalanceFromIndexer(address);
  const allowed = balance > 0n;

  const { positiveTtlMs, negativeTtlMs } = getCacheTtls(opts);
  const ttlMs = allowed ? positiveTtlMs : negativeTtlMs;
  accessCache.set(cacheKey, { allowed, expiresAtMs: nowMs + ttlMs });

  // Periodic eviction to prevent unbounded growth
  evictExpiredCacheEntries(nowMs);

  return allowed;
}

type TokenOwnerRow = {
  tokenId: string;
  updatedAt: string;
  owner: { address: string } | null;
};

type TokensByIdsQueryData = {
  NftToken: TokenOwnerRow[];
};

export async function getNftTokenOwnersFromIndexer(
  tokenIds: number[]
): Promise<Map<number, { ownerAddress: string; acquiredAt: string }>> {
  const url = getNftIndexerGraphqlUrl();
  if (!url) {
    throw new NftIndexerUnavailableError(
      'NFT_INDEXER_GRAPHQL_URL not configured'
    );
  }

  let collectionId: string;
  try {
    collectionId = getNftCollectionIdFromEnv();
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new NftIndexerUnavailableError(
        'NFT collection config not valid',
        error
      );
    }
    throw error;
  }
  const tokenIdStrings = tokenIds.map((id) => String(id));

  const data = await fetchGraphql<TokensByIdsQueryData>(url, {
    query:
      'query($cid:String!,$tokenIds:[numeric!]!){NftToken(where:{collection_id:{_eq:$cid},tokenId:{_in:$tokenIds}}){tokenId updatedAt owner{address}}}',
    variables: { cid: collectionId, tokenIds: tokenIdStrings },
  });

  const map = new Map<number, { ownerAddress: string; acquiredAt: string }>();
  for (const row of data.NftToken) {
    if (!row.owner?.address) continue;
    const tokenIdNumber = Number.parseInt(row.tokenId, 10);
    if (!Number.isSafeInteger(tokenIdNumber)) continue;
    map.set(tokenIdNumber, {
      ownerAddress: normalizeHexAddress(row.owner.address),
      acquiredAt: new Date(row.updatedAt).toISOString(),
    });
  }

  return map;
}

type OwnedTokensQueryData = {
  NftToken: Array<{ tokenId: string }>;
};

export async function getOwnedTokenIdsFromIndexer(
  walletAddress: string,
  opts?: { limit?: number }
): Promise<number[]> {
  const url = getNftIndexerGraphqlUrl();
  if (!url) {
    throw new NftIndexerUnavailableError(
      'NFT_INDEXER_GRAPHQL_URL not configured'
    );
  }

  let collectionId: string;
  try {
    collectionId = getNftCollectionIdFromEnv();
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new NftIndexerUnavailableError(
        'NFT collection config not valid',
        error
      );
    }
    throw error;
  }
  const address = normalizeHexAddress(walletAddress);
  const limit = Math.min(500, Math.max(1, opts?.limit ?? 200));

  const data = await fetchGraphql<OwnedTokensQueryData>(url, {
    query:
      'query($cid:String!,$addr:String!,$limit:Int!){NftToken(where:{collection_id:{_eq:$cid},owner:{address:{_eq:$addr}}},order_by:[{tokenId:asc}],limit:$limit){tokenId}}',
    variables: { cid: collectionId, addr: address, limit },
  });

  const tokenIds: number[] = [];
  for (const row of data.NftToken) {
    const tokenIdNumber = Number.parseInt(row.tokenId, 10);
    if (Number.isSafeInteger(tokenIdNumber)) tokenIds.push(tokenIdNumber);
  }
  return tokenIds;
}

/**
 * Best-effort "keep current access" fallback when the indexer is unavailable:
 * treat DB ownership as truthy for minted users and local testing.
 */
export async function getOwnedTokenIdsFromDbFallback(
  dbUserId: string
): Promise<number[]> {
  const rows = await db
    .select({ tokenId: nftOwnership.tokenId })
    .from(nftOwnership)
    .where(eq(nftOwnership.userId, dbUserId));
  return rows.map((r) => r.tokenId);
}

export async function getOwnerUsersByWalletAddresses(
  ownerAddresses: string[]
): Promise<
  Map<
    string,
    {
      id: string;
      username: string | null;
      displayName: string | null;
      profileImageUrl: string | null;
    }
  >
> {
  if (ownerAddresses.length === 0) return new Map();

  const normalized = Array.from(
    new Set(ownerAddresses.map(normalizeHexAddress))
  );
  const rows = await db
    .select({
      id: users.id,
      walletAddress: users.walletAddress,
      username: users.username,
      displayName: users.displayName,
      profileImageUrl: users.profileImageUrl,
    })
    .from(users)
    .where(inArray(users.walletAddress, normalized));

  const map = new Map<
    string,
    {
      id: string;
      username: string | null;
      displayName: string | null;
      profileImageUrl: string | null;
    }
  >();
  for (const row of rows) {
    const addr = row.walletAddress
      ? normalizeHexAddress(row.walletAddress)
      : null;
    if (!addr) continue;
    map.set(addr, {
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      profileImageUrl: row.profileImageUrl,
    });
  }
  return map;
}
