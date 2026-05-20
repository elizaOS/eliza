/**
 * NFT Image Proxy API
 *
 * @route GET /api/nft/image/[tokenId] - Proxy NFT images from IPFS
 * @access Public
 *
 * @description
 * Proxies NFT images from IPFS gateways to avoid CORS issues and provide
 * reliable, fast delivery via Vercel CDN. Includes in-memory caching,
 * multi-gateway fallback, and distributed rate limiting.
 */

import {
  checkRateLimitAsync,
  getClientIp,
  RATE_LIMIT_CONFIGS,
  withErrorHandling,
} from '@feed/api';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

/** IPFS CID for the NFT images collection (required) */
const IPFS_IMAGES_CID = process.env.NFT_IPFS_IMAGES_CID;

/** IPFS gateways to try in order (fallback chain) */
const IPFS_GATEWAYS = IPFS_IMAGES_CID
  ? [
      `https://ipfs.io/ipfs/${IPFS_IMAGES_CID}`,
      `https://dweb.link/ipfs/${IPFS_IMAGES_CID}`,
      `https://cloudflare-ipfs.com/ipfs/${IPFS_IMAGES_CID}`,
    ]
  : [];

if (!IPFS_IMAGES_CID) {
  logger.warn(
    'NFT_IPFS_IMAGES_CID not set — image proxy will return 502 for all requests',
    undefined,
    'NFT Image Proxy'
  );
}

/**
 * NFT collection size - determines valid tokenId range (1 to COLLECTION_SIZE).
 *
 * Configure via NFT_COLLECTION_SIZE environment variable.
 * Default: 100 (fallback when env var is not set or invalid)
 */
const COLLECTION_SIZE = Number(process.env.NFT_COLLECTION_SIZE) || 100;

/**
 * Max cache size to prevent memory leaks (FIFO eviction when exceeded).
 *
 * Memory considerations:
 * - Each entry contains an ArrayBuffer (typically 50KB-500KB for images)
 * - At MAX_CACHE_SIZE=100 entries, worst case memory is ~50MB
 * - Acceptable for Vercel serverless functions (1GB limit)
 */
const MAX_CACHE_SIZE = 100;

/**
 * Maximum total bytes for the cache (10MB).
 * Evicts oldest entries (FIFO) when exceeded.
 */
const MAX_CACHE_BYTES = 10 * 1024 * 1024;

/**
 * Maximum bytes for a single cache entry (2MB).
 * Entries larger than this are not cached to prevent one large image
 * from consuming too much of the cache budget.
 */
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;

/**
 * In-memory cache for image data (survives across requests in same worker).
 *
 * Note: In serverless environments, each instance maintains a separate cache.
 * This means cache hits are not shared across instances, but this is acceptable
 * because:
 * 1. Vercel CDN provides the primary caching layer (immutable headers)
 * 2. This cache only reduces IPFS gateway calls for warm instances
 * 3. Images are immutable, so inconsistency between instances is not an issue
 */
const imageCache = new Map<
  number,
  {
    buffer: ArrayBuffer;
    contentType: string;
    cachedAt: number;
    byteLength: number;
  }
>();

/** Tracks total cached bytes for memory budget enforcement */
let totalCachedBytes = 0;

/** Cache TTL: 1 hour (images are immutable, but allow refresh for updates) */
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Add to cache with FIFO eviction when max size or byte limit exceeded.
 * Leverages Map's insertion order: first key is the oldest entry.
 *
 * @param tokenId - The token ID to cache
 * @param buffer - The image ArrayBuffer
 * @param contentType - The content type of the image
 * @returns true if cached, false if entry was too large to cache
 */
function addToCache(
  tokenId: number,
  buffer: ArrayBuffer,
  contentType: string
): boolean {
  const byteLength = buffer.byteLength;

  if (byteLength > MAX_ENTRY_BYTES) {
    logger.debug(
      `Skipping cache for token ${tokenId}: entry too large (${byteLength} bytes > ${MAX_ENTRY_BYTES})`,
      { tokenId, byteLength },
      'NFT Image Proxy'
    );
    return false;
  }

  // Evict oldest entries until we have room for the new entry (FIFO)
  while (
    (imageCache.size >= MAX_CACHE_SIZE ||
      totalCachedBytes + byteLength > MAX_CACHE_BYTES) &&
    imageCache.size > 0
  ) {
    const oldestKey = imageCache.keys().next().value;
    if (oldestKey !== undefined) {
      const oldEntry = imageCache.get(oldestKey);
      if (oldEntry) {
        totalCachedBytes -= oldEntry.byteLength;
      }
      imageCache.delete(oldestKey);
    }
  }

  imageCache.set(tokenId, {
    buffer,
    contentType,
    cachedAt: Date.now(),
    byteLength,
  });
  totalCachedBytes += byteLength;

  return true;
}

/** Fetch timeout in milliseconds */
const FETCH_TIMEOUT_MS = 15 * 1000; // 15 seconds (IPFS can be slower than GitHub)

/** Helper to create a fetch with timeout using AbortController */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch image from IPFS with multi-gateway fallback.
 * Tries each gateway in order until one succeeds.
 */
async function fetchFromIpfs(
  tokenId: number
): Promise<{ buffer: ArrayBuffer; contentType: string } | null> {
  for (const gateway of IPFS_GATEWAYS) {
    const url = `${gateway}/${tokenId}.png`;
    try {
      const response = await fetchWithTimeout(url, {
        headers: { 'User-Agent': 'Feed-NFT-Proxy/1.0' },
      });

      if (response.ok) {
        const buffer = await response.arrayBuffer();
        const contentType = response.headers.get('content-type') || 'image/png';
        return { buffer, contentType };
      }

      logger.debug(
        `IPFS gateway returned ${response.status} for token ${tokenId}`,
        { gateway, status: response.status },
        'NFT Image Proxy'
      );
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === 'AbortError';
      logger.debug(
        `IPFS gateway ${isTimeout ? 'timed out' : 'failed'} for token ${tokenId}`,
        {
          gateway,
          error: error instanceof Error ? error.message : String(error),
        },
        'NFT Image Proxy'
      );
    }
  }

  return null;
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/nft/image/[tokenId]
 * Proxy NFT image from IPFS with caching and distributed rate limiting
 */
export const GET = withErrorHandling(async function GET(
  request: NextRequest,
  context: { params: Promise<{ tokenId: string }> }
) {
  const clientIp = getClientIp(request.headers);

  // Validate tokenId before any expensive operations
  const { tokenId: tokenIdStr } = await context.params;
  const tokenId = Number(tokenIdStr);

  if (
    !tokenIdStr ||
    isNaN(tokenId) ||
    tokenId < 1 ||
    tokenId > COLLECTION_SIZE
  ) {
    return NextResponse.json({ error: 'Invalid token ID' }, { status: 400 });
  }

  // Check in-memory cache first (doesn't count against rate limit)
  const cached = imageCache.get(tokenId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return new NextResponse(cached.buffer, {
      status: 200,
      headers: {
        'Content-Type': cached.contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'CDN-Cache-Control': 'public, max-age=31536000',
        'Vercel-CDN-Cache-Control': 'public, max-age=31536000',
        'X-Cache': 'HIT',
      },
    });
  }

  // Apply distributed rate limit for cache misses (actual IPFS gateway calls)
  const rateLimitConfig = clientIp
    ? RATE_LIMIT_CONFIGS.PUBLIC_NFT_IMAGE
    : RATE_LIMIT_CONFIGS.PUBLIC_NFT_IMAGE_ANONYMOUS;
  const rateLimitKey = clientIp ? `ip:${clientIp}` : 'ip:anonymous';
  const rateLimit = await checkRateLimitAsync(rateLimitKey, rateLimitConfig);

  if (!rateLimit.allowed) {
    const retryAfterSeconds = rateLimit.retryAfter ?? 60;
    logger.warn(
      `Rate limit exceeded for NFT image request`,
      { ip: clientIp?.slice(0, 8), tokenId, retryAfter: retryAfterSeconds },
      'GET /api/nft/image/[tokenId]'
    );
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: retryAfterSeconds },
      {
        status: 429,
        headers: {
          'Retry-After': String(retryAfterSeconds),
        },
      }
    );
  }

  try {
    const result = await fetchFromIpfs(tokenId);

    if (!result) {
      logger.warn(
        `All IPFS gateways failed for NFT image #${tokenId}`,
        { tokenId },
        'GET /api/nft/image/[tokenId]'
      );
      return NextResponse.json({ error: 'Image not found' }, { status: 502 });
    }

    // Store in cache (with FIFO eviction based on insertion time)
    addToCache(tokenId, result.buffer, result.contentType);

    // Return image with proper headers and caching
    return new NextResponse(result.buffer, {
      status: 200,
      headers: {
        'Content-Type': result.contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'CDN-Cache-Control': 'public, max-age=31536000',
        'Vercel-CDN-Cache-Control': 'public, max-age=31536000',
        'X-Cache': 'MISS',
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      logger.warn(
        `Timeout fetching NFT image #${tokenId}`,
        { tokenId },
        'GET /api/nft/image/[tokenId]'
      );
      return NextResponse.json({ error: 'Gateway timeout' }, { status: 504 });
    }

    logger.error(
      `Error proxying NFT image #${tokenId}`,
      {
        tokenId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'GET /api/nft/image/[tokenId]'
    );

    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
});
