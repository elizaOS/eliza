import {
  addPublicReadHeaders,
  getCacheOrFetch,
  publicRateLimit,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import type { NarrativeStory } from '@feed/shared';
import { toISO } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { decodeCursor, encodeCursor, findCursorIndex } from '../feed-cursor';
import { buildForYouFeed } from './pipeline';

const PAGE_SIZE = 20;
// 1-minute per-user ranked snapshot. Scoring compute is ~20ms (in-memory
// rescoring of globally-cached base candidates), so short TTL is fine. At
// 700K users with ~1% concurrent in 60s, this yields ~7K Redis entries ×
// ~2MB ≈ 14GB — fits comfortably in a standard Redis instance.
const RANKED_CACHE_TTL_S = 60;

export const GET = withErrorHandling(async (request: NextRequest) => {
  const {
    error: rateLimitError,
    user,
    rateLimitInfo,
  } = await publicRateLimit(request, 'read');
  if (rateLimitError) {
    return rateLimitError;
  }

  const { searchParams } = request.nextUrl;
  const cursorParam = searchParams.get('cursor');
  const rawLimit = Number(searchParams.get('limit') ?? PAGE_SIZE);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(PAGE_SIZE, Math.max(1, rawLimit))
    : PAGE_SIZE;

  const userId = user?.userId ?? null;
  // Per-user ranked snapshot. Anonymous users share one snapshot;
  // authenticated users each get their own personalised ranking.
  const cacheKey = userId
    ? `feed:for-you:ranked:v1:${userId}`
    : 'feed:for-you:ranked:v1:anon';

  const fullResult = await getCacheOrFetch<{
    stories: NarrativeStory[];
    generatedAt: string;
  }>(cacheKey, () => buildForYouFeed(userId), { ttl: RANKED_CACHE_TTL_S });

  const decoded = cursorParam ? decodeCursor(cursorParam) : null;
  const startIndex = decoded ? findCursorIndex(fullResult.stories, decoded) : 0;
  const page = fullResult.stories.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + limit < fullResult.stories.length;

  const lastStory = page[page.length - 1];
  const nextCursor = lastStory
    ? encodeCursor(
        lastStory.finalRankScore ?? lastStory.storyScore,
        lastStory.storyKey
      )
    : null;

  const response = successResponse({
    success: true,
    stories: page,
    hasMore,
    nextCursor,
    generatedAt: fullResult.generatedAt,
  });

  if (rateLimitInfo) {
    if (userId) {
      response.headers.set('Cache-Control', 'private, no-store');
      response.headers.set('X-RateLimit-Limit', rateLimitInfo.limit.toString());
      response.headers.set(
        'X-RateLimit-Remaining',
        rateLimitInfo.remaining.toString()
      );
      response.headers.set('X-RateLimit-Reset', toISO(rateLimitInfo.resetAt));
    } else {
      addPublicReadHeaders(response, rateLimitInfo);
    }
  }

  return response;
});
